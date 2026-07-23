/**
 * Classify META-INF/encryption.xml for Release 0.1.
 * Allow standard EPUB font obfuscation; reject content DRM / unknown algorithms.
 *
 * Uses DOMParser so XML comments cannot decoy algorithm/URI pairs (regex fails closed).
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

/** True font file extensions only — never substring "font". */
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
  /** True when the EncryptedData block is structurally invalid. */
  malformed?: boolean;
}

function localNameOf(node: Node): string {
  const el = node as Element;
  if (typeof el.localName === "string" && el.localName) {
    return el.localName;
  }
  const tag = (el as { tagName?: string }).tagName ?? "";
  const parts = tag.split(":");
  return parts[parts.length - 1] ?? tag;
}

function isParserErrorDocument(doc: Document): boolean {
  if (doc.getElementsByTagName("parsererror").length > 0) {
    return true;
  }
  // Some engines use namespaced parsererror under html.
  const root = doc.documentElement;
  if (root && localNameOf(root).toLowerCase() === "parsererror") {
    return true;
  }
  return false;
}

/**
 * Collect direct-or-descendant EncryptionMethod / CipherReference under one
 * EncryptedData, skipping nested EncryptedData subtrees.
 */
function collectBlockChildren(block: Element): {
  methods: Element[];
  refs: Element[];
} {
  const methods: Element[] = [];
  const refs: Element[] = [];

  const walk = (node: Element): void => {
    for (const child of Array.from(node.children)) {
      const name = localNameOf(child);
      if (name === "EncryptedData") {
        // Nested block — do not harvest its methods into the parent.
        continue;
      }
      if (name === "EncryptionMethod") {
        methods.push(child);
      } else if (name === "CipherReference") {
        refs.push(child);
      } else {
        walk(child);
      }
    }
  };
  walk(block);
  return { methods, refs };
}

/**
 * Parse encryption.xml with DOMParser. Fail closed on parse errors and
 * duplicate/missing method/uri within a block. Comments never contribute nodes.
 */
function parseEncryptedEntries(
  text: string,
): EncryptedEntry[] | { error: "malformed" } {
  if (typeof DOMParser === "undefined") {
    return { error: "malformed" };
  }

  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(text, "application/xml");
  } catch {
    return { error: "malformed" };
  }

  if (isParserErrorDocument(doc)) {
    return { error: "malformed" };
  }

  const entries: EncryptedEntry[] = [];
  const all = doc.getElementsByTagName("*");
  for (const el of Array.from(all)) {
    if (localNameOf(el) !== "EncryptedData") continue;

    const { methods, refs } = collectBlockChildren(el);

    // Exactly one method and one cipher reference per block.
    if (methods.length !== 1 || refs.length !== 1) {
      entries.push({ algo: "", uri: "", malformed: true });
      continue;
    }

    const algo = (methods[0]!.getAttribute("Algorithm") ?? "")
      .trim()
      .toLowerCase();
    const uri = (refs[0]!.getAttribute("URI") ?? "").trim();
    entries.push({ algo, uri });
  }

  return entries;
}

function looksLikeFontUri(uri: string): boolean {
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
  const parsed = parseEncryptedEntries(text);

  if ("error" in parsed) {
    return { kind: "unknown", reason: "malformed-encryption-xml" };
  }

  const entries = parsed;

  if (entries.length === 0) {
    // Well-formed XML with no EncryptedData — treat as none unless text
    // clearly claimed encryption without parseable blocks (shouldn't happen
    // after DOM parse of valid XML).
    return { kind: "none" };
  }

  const fontPaths: string[] = [];
  let sawContent = false;
  let sawUnknown = false;
  let unknownReason = "unclassified-encryption";

  for (const entry of entries) {
    if (entry.malformed) {
      sawUnknown = true;
      unknownReason = "malformed-encrypted-data-block";
      continue;
    }

    const { algo, uri } = entry;
    const isFontAlgo = Boolean(algo) && FONT_ALGORITHMS.has(algo);
    const looksLikeFont = looksLikeFontUri(uri);

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

    if (isFontAlgo && looksLikeFont) {
      fontPaths.push(uri);
      continue;
    }

    if (isFontAlgo && !looksLikeFont) {
      sawContent = true;
      break;
    }

    if (algo && !isFontAlgo) {
      if (CONTENT_EXT.test(uri) || IMAGE_EXT.test(uri) || !looksLikeFont) {
        sawContent = true;
        break;
      }
      sawUnknown = true;
      unknownReason = `unknown-algorithm:${algo}`;
      continue;
    }

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

  // Any malformed/unknown block fails closed even when other fonts are valid.
  if (sawUnknown) {
    return { kind: "unknown", reason: unknownReason };
  }

  const nonFontAlgos = entries
    .filter((e) => !e.malformed)
    .map((e) => e.algo)
    .filter((a) => a && !FONT_ALGORITHMS.has(a));
  if (nonFontAlgos.length > 0) {
    return {
      kind: "unknown",
      reason: `unknown-algorithm:${nonFontAlgos[0]}`,
    };
  }

  const validEntries = entries.filter((e) => !e.malformed);
  const allFontPairs =
    validEntries.length > 0 &&
    validEntries.every(
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
