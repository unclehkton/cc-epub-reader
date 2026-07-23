/**
 * Classify META-INF/encryption.xml for Release 0.1.
 * Allow standard EPUB font obfuscation; reject content DRM / unknown algorithms.
 */

/** IDPF font embedding (obfuscation) algorithm. */
export const IDPF_FONT_OBFUSCATION =
  "http://www.idpf.org/2008/embedding";

/** Adobe font obfuscation algorithm. */
export const ADOBE_FONT_OBFUSCATION = "http://ns.adobe.com/pdf/enc#RC";

const FONT_ALGORITHMS = new Set([
  IDPF_FONT_OBFUSCATION.toLowerCase(),
  ADOBE_FONT_OBFUSCATION.toLowerCase(),
  // Some packages omit the scheme host casing variants
  "http://www.idpf.org/2008/embedding".toLowerCase(),
]);

const FONT_EXT = /\.(otf|ttf|woff2?|eot)(\?|#|$)/i;

export type EncryptionClassification =
  | { kind: "none" }
  | { kind: "font-obfuscation-only"; fontPaths: string[] }
  | { kind: "content-drm"; reason: string }
  | { kind: "unknown"; reason: string };

/**
 * Parse encryption.xml text. Fail closed on unrecognised content encryption.
 */
export function classifyEncryptionXml(xml: string | null | undefined): EncryptionClassification {
  if (xml == null || !String(xml).trim()) {
    return { kind: "none" };
  }
  const text = String(xml);

  // Collect EncryptionMethod Algorithm attributes
  const algoMatches = [
    ...text.matchAll(/EncryptionMethod[^>]*Algorithm\s*=\s*["']([^"']+)["']/gi),
  ];
  const algorithms = algoMatches.map((m) => (m[1] ?? "").trim().toLowerCase());

  // Collect CipherReference URI attributes
  const uriMatches = [
    ...text.matchAll(/CipherReference[^>]*URI\s*=\s*["']([^"']+)["']/gi),
  ];
  const uris = uriMatches.map((m) => (m[1] ?? "").trim());

  if (algorithms.length === 0 && uris.length === 0) {
    // Empty or non-standard stub — treat as unknown if EncryptedData present
    if (/EncryptedData/i.test(text)) {
      return { kind: "unknown", reason: "encrypted-data-without-methods" };
    }
    return { kind: "none" };
  }

  const fontPaths: string[] = [];
  let sawContent = false;
  let sawUnknownAlgo = false;

  for (let i = 0; i < Math.max(algorithms.length, uris.length); i += 1) {
    const algo = algorithms[i] ?? algorithms[0] ?? "";
    const uri = uris[i] ?? "";
    const isFontAlgo = FONT_ALGORITHMS.has(algo);
    const looksLikeFont = FONT_EXT.test(uri) || /font/i.test(uri);

    if (isFontAlgo || (looksLikeFont && isFontAlgo)) {
      if (uri) fontPaths.push(uri);
      continue;
    }

    if (isFontAlgo && looksLikeFont) {
      if (uri) fontPaths.push(uri);
      continue;
    }

    // Algorithm not in allowlist
    if (algo && !FONT_ALGORITHMS.has(algo)) {
      // Content document encryption
      if (/\.(x?html?|xml|opf|ncx|nav)(\?|#|$)/i.test(uri) || !uri) {
        sawContent = true;
        break;
      }
      if (/\.(jpe?g|png|gif|svg|webp)(\?|#|$)/i.test(uri)) {
        sawContent = true;
        break;
      }
      sawUnknownAlgo = true;
    }

    // Font algo but URI is clearly content
    if (isFontAlgo && uri && !looksLikeFont) {
      if (/\.(x?html?|xml|opf)(\?|#|$)/i.test(uri)) {
        sawContent = true;
        break;
      }
    }

    // No recognised font algorithm
    if (!isFontAlgo) {
      if (looksLikeFont && !algo) {
        // URI looks like font but algo missing — unknown
        sawUnknownAlgo = true;
      } else if (!looksLikeFont) {
        sawContent = true;
        break;
      }
    }
  }

  if (sawContent) {
    return { kind: "content-drm", reason: "encrypted-reading-content" };
  }

  // All algorithms must be font obfuscation when present
  const nonFontAlgos = algorithms.filter((a) => a && !FONT_ALGORITHMS.has(a));
  if (nonFontAlgos.length > 0) {
    return {
      kind: "unknown",
      reason: `unknown-algorithm:${nonFontAlgos[0]}`,
    };
  }

  if (sawUnknownAlgo && fontPaths.length === 0) {
    return { kind: "unknown", reason: "unclassified-encryption" };
  }

  // Font-only (or empty URI list with only font algorithms)
  if (
    algorithms.every((a) => !a || FONT_ALGORITHMS.has(a)) &&
    (uris.length === 0 || uris.every((u) => !u || FONT_EXT.test(u) || /font/i.test(u)))
  ) {
    return {
      kind: "font-obfuscation-only",
      fontPaths: fontPaths.length ? fontPaths : uris.filter(Boolean),
    };
  }

  return { kind: "unknown", reason: "mixed-or-unparsed" };
}

/** True when encryption.xml should cause import rejection. */
export function shouldRejectEncryption(xml: string | null | undefined): boolean {
  const c = classifyEncryptionXml(xml);
  return c.kind === "content-drm" || c.kind === "unknown";
}
