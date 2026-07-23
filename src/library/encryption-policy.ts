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

const FONT_EXT = /\.(otf|ttf|woff2?|eot)(\?|#|$)/i;
const CONTENT_EXT = /\.(x?html?|xml|opf|ncx|nav)(\?|#|$)/i;
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

  // Self-closing / truncated stubs: still collect what we can, paired loosely
  // only when a single method+uri pair is present.
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
  // Multiple unpaired methods — treat each algorithm as its own entry (no URI)
  // so unknown/content algorithms are not dropped.
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
  return FONT_EXT.test(uri) || /font/i.test(uri);
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
  let sawUnknownAlgo = false;
  let unknownReason = "unclassified-encryption";

  for (const { algo, uri } of entries) {
    const isFontAlgo = Boolean(algo) && FONT_ALGORITHMS.has(algo);
    const looksLikeFont = looksLikeFontUri(uri);

    // Font obfuscation is allowed ONLY when algorithm AND URI both look like fonts.
    if (isFontAlgo && looksLikeFont) {
      if (uri) fontPaths.push(uri);
      continue;
    }

    // Font algorithm applied to non-font (e.g. XHTML) — content DRM.
    if (isFontAlgo && uri && !looksLikeFont) {
      if (CONTENT_EXT.test(uri) || IMAGE_EXT.test(uri) || !FONT_EXT.test(uri)) {
        sawContent = true;
        break;
      }
    }

    // Font algorithm with empty URI — cannot verify resource type; fail closed.
    if (isFontAlgo && !uri) {
      sawUnknownAlgo = true;
      unknownReason = "font-algorithm-without-uri";
      continue;
    }

    // Non-font algorithm on content or images.
    if (algo && !isFontAlgo) {
      if (!uri || CONTENT_EXT.test(uri) || IMAGE_EXT.test(uri)) {
        sawContent = true;
        break;
      }
      sawUnknownAlgo = true;
      unknownReason = `unknown-algorithm:${algo}`;
      continue;
    }

    // Missing algorithm
    if (!algo) {
      if (looksLikeFont) {
        sawUnknownAlgo = true;
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

  const nonFontAlgos = entries
    .map((e) => e.algo)
    .filter((a) => a && !FONT_ALGORITHMS.has(a));
  if (nonFontAlgos.length > 0) {
    return {
      kind: "unknown",
      reason: `unknown-algorithm:${nonFontAlgos[0]}`,
    };
  }

  if (sawUnknownAlgo && fontPaths.length === 0) {
    return { kind: "unknown", reason: unknownReason };
  }

  // All paired entries must be font-obfuscation-only.
  const allFontPairs = entries.every((e) => {
    if (!e.algo) return false;
    if (!FONT_ALGORITHMS.has(e.algo)) return false;
    return !e.uri || looksLikeFontUri(e.uri);
  });

  if (allFontPairs && (fontPaths.length > 0 || entries.every((e) => e.algo))) {
    return {
      kind: "font-obfuscation-only",
      fontPaths: fontPaths.length
        ? fontPaths
        : entries.map((e) => e.uri).filter(Boolean),
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
