/**
 * Classify META-INF/encryption.xml for Release 0.1.
 * Allow standard EPUB font obfuscation; reject content DRM / unknown algorithms.
 *
 * Pair algorithm + URI per EncryptedData block (never index-align global regex
 * lists — that can mis-pair font algorithms with content URIs).
 */

/** IDPF font embedding (obfuscation) algorithm. */
export const IDPF_FONT_OBFUSCATION =
  "http://www.idpf.org/2008/embedding";

/** Adobe font obfuscation algorithm. */
export const ADOBE_FONT_OBFUSCATION = "http://ns.adobe.com/pdf/enc#RC";

const FONT_ALGORITHMS = new Set([
  IDPF_FONT_OBFUSCATION.toLowerCase(),
  ADOBE_FONT_OBFUSCATION.toLowerCase(),
]);

/** True font file extensions only — never substring "font" (bypasses via font-chapter.xhtml). */
const FONT_EXT = /\.(otf|ttf|woff2?|eot)(\?|#|$)/i;
const CONTENT_EXT = /\.(x?html?|xml|opf|ncx|nav|css|js)(\?|#|$)/i;
const IMAGE_EXT = /\.(jpe?g|png|gif|svg|webp)(\?|#|$)/i;

export type EncryptionClassification =
  | { kind: "none" }
  | { kind: "font-obfuscation-only"; fontPaths: string[] }
  | { kind: "content-drm"; reason: string }
  | { kind: "unknown"; reason: string };

interface EncryptedEntry {
  algo: string;
  uri: string;
}

/**
 * Extract algorithm + URI pairs from each EncryptedData element.
 * Falls back to whole-document parse when tags are not well-formed.
 */
function parseEncryptedEntries(text: string): EncryptedEntry[] {
  const entries: EncryptedEntry[] = [];
  const blockRe = /<EncryptedData\b[\s\S]*?<\/EncryptedData>/gi;
  let match: RegExpExecArray | null;
  let foundBlock = false;

  while ((match = blockRe.exec(text)) !== null) {
    foundBlock = true;
    const block = match[0];
    const algoMatch = /EncryptionMethod[^>]*Algorithm\s*=\s*["']([^"']+)["']/i.exec(
      block,
    );
    const uriMatch = /CipherReference[^>]*URI\s*=\s*["']([^"']+)["']/i.exec(
      block,
    );
    entries.push({
      algo: (algoMatch?.[1] ?? "").trim().toLowerCase(),
      uri: (uriMatch?.[1] ?? "").trim(),
    });
  }

  if (foundBlock) {
    return entries;
  }

  const algoMatches = [
    ...text.matchAll(/EncryptionMethod[^>]*Algorithm\s*=\s*["']([^"']+)["']/gi),
  ];
  const uriMatches = [
    ...text.matchAll(/CipherReference[^>]*URI\s*=\s*["']([^"']+)["']/gi),
  ];
  if (algoMatches.length === 1 && uriMatches.length === 1) {
    return [
      {
        algo: (algoMatches[0]![1] ?? "").trim().toLowerCase(),
        uri: (uriMatches[0]![1] ?? "").trim(),
      },
    ];
  }
  if (algoMatches.length === 0 && uriMatches.length === 0) {
    return [];
  }
  if (algoMatches.length > 0) {
    return algoMatches.map((m) => ({
      algo: (m[1] ?? "").trim().toLowerCase(),
      uri: "",
    }));
  }
  return uriMatches.map((m) => ({
    algo: "",
    uri: (m[1] ?? "").trim(),
  }));
}

function looksLikeFontUri(uri: string): boolean {
  // Extension-only. Substring "font" is an intentional bypass hole.
  return FONT_EXT.test(uri);
}

/**
 * Parse encryption.xml text. Fail closed on unrecognised content encryption.
 */
export function classifyEncryptionXml(
  xml: string | null | undefined,
): EncryptionClassification {
  if (xml == null || !String(xml).trim()) {
    return { kind: "none" };
  }
  const text = String(xml);
  const entries = parseEncryptedEntries(text);

  if (entries.length === 0) {
    if (/EncryptedData/i.test(text)) {
      return { kind: "unknown", reason: "encrypted-data-without-methods" };
    }
    return { kind: "none" };
  }

  const fontPaths: string[] = [];
  let sawContent = false;
  let sawUnknown = false;
  let unknownReason = "unclassified-encryption";

  for (const { algo, uri } of entries) {
    const isFontAlgo = Boolean(algo) && FONT_ALGORITHMS.has(algo);
    const looksLikeFont = looksLikeFontUri(uri);

    // Empty URI: cannot verify resource type — fail closed (never allow via decoy fonts).
    if (!uri) {
      if (isFontAlgo) {
        sawUnknown = true;
        unknownReason = "font-algorithm-without-uri";
      } else if (algo) {
        sawContent = true;
        break;
      } else {
        sawUnknown = true;
        unknownReason = "encrypted-data-without-uri";
      }
      continue;
    }

    // Font obfuscation is allowed ONLY when algorithm AND URI are both fonts.
    if (isFontAlgo && looksLikeFont) {
      fontPaths.push(uri);
      continue;
    }

    // Font algorithm on non-font resource (xhtml, css, image, …).
    if (isFontAlgo && !looksLikeFont) {
      sawContent = true;
      break;
    }

    // Non-font algorithm.
    if (algo && !isFontAlgo) {
      if (CONTENT_EXT.test(uri) || IMAGE_EXT.test(uri) || !looksLikeFont) {
        sawContent = true;
        break;
      }
      sawUnknown = true;
      unknownReason = `unknown-algorithm:${algo}`;
      continue;
    }

    // Missing algorithm
    if (!algo) {
      if (looksLikeFont) {
        sawUnknown = true;
        unknownReason = "font-uri-without-algorithm";
      } else {
        sawContent = true;
        break;
      }
    }
  }

  if (sawContent) {
    return { kind: "content-drm", reason: "encrypted-reading-content" };
  }

  // Any unknown/empty-URI entry blocks even when other fonts are present.
  if (sawUnknown) {
    return { kind: "unknown", reason: unknownReason };
  }

  const nonFontAlgos = entries
    .map((e) => e.algo)
    .filter((a) => a && !FONT_ALGORITHMS.has(a));
  if (nonFontAlgos.length > 0) {
    return {
      kind: "unknown",
      reason: `unknown-algorithm:${nonFontAlgos[0]}`,
    };
  }

  // Every entry must be a font-algo + font-extension URI pair.
  const allFontPairs = entries.every(
    (e) =>
      Boolean(e.algo) &&
      FONT_ALGORITHMS.has(e.algo) &&
      Boolean(e.uri) &&
      looksLikeFontUri(e.uri),
  );

  if (allFontPairs && fontPaths.length > 0) {
    return {
      kind: "font-obfuscation-only",
      fontPaths,
    };
  }

  return { kind: "unknown", reason: "mixed-or-unparsed" };
}

/** True when encryption.xml should cause import rejection. */
export function shouldRejectEncryption(
  xml: string | null | undefined,
): boolean {
  const c = classifyEncryptionXml(xml);
  return c.kind === "content-drm" || c.kind === "unknown";
}
