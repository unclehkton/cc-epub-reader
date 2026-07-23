import JSZip from "jszip";
import type { ValidatedImport } from "../domain/types";
import { shouldRejectEncryption } from "./encryption-policy";
import { ImportError } from "./import-errors";
import { ZipStructureException, assertZipStructure } from "./zip-structure";

export const MAX_EPUB_BYTES = 100 * 1024 * 1024;
/** Max uncompressed size for container.xml / package OPF text entries. */
export const MAX_METADATA_ENTRY_BYTES = 2 * 1024 * 1024;
/** Max declared uncompressed size for any single ZIP entry (chapters/assets). */
export const MAX_ENTRY_UNCOMPRESSED_BYTES = 20 * 1024 * 1024;
/** Max sum of declared uncompressed sizes across all ZIP entries. */
export const MAX_TOTAL_UNCOMPRESSED_BYTES = 150 * 1024 * 1024;

const ZIP_LOCAL_FILE_HEADER = [0x50, 0x4b, 0x03, 0x04] as const;
const ACCEPTED_MIME = new Set([
  "application/epub+zip",
  "application/zip",
  "application/x-zip-compressed",
]);

export interface ValidateEpubOptions {
  maxBytes?: number;
  /** Override per-entry declared uncompressed ceiling (tests / constrained hosts). */
  maxEntryUncompressedBytes?: number;
  /** Override aggregate declared uncompressed ceiling. */
  maxTotalUncompressedBytes?: number;
}

function hasEpubExtension(fileName: string): boolean {
  return fileName.toLowerCase().endsWith(".epub");
}

function isAcceptedMime(type: string): boolean {
  if (!type) {
    return false;
  }
  return ACCEPTED_MIME.has(type.toLowerCase());
}

async function hasZipMagic(file: Blob): Promise<boolean> {
  if (file.size < 4) {
    return false;
  }
  const header = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  return ZIP_LOCAL_FILE_HEADER.every((byte, index) => header[index] === byte);
}

/**
 * Read a JSZip entry's declared uncompressed size when available.
 * Missing sizes are treated as unknown (0 contribution) rather than trusted.
 */
function declaredUncompressedSize(entry: unknown): number | undefined {
  const record = entry as {
    _data?: { uncompressedSize?: number };
    uncompressedSize?: number;
  };
  if (typeof record.uncompressedSize === "number") {
    return record.uncompressedSize;
  }
  if (typeof record._data?.uncompressedSize === "number") {
    return record._data.uncompressedSize;
  }
  return undefined;
}

/**
 * Reject ZIP entries whose declared uncompressed size exceeds the ceiling
 * before calling JSZip async decompression (ZIP bomb mitigation).
 */
function assertEntrySize(entry: unknown, maxBytes: number): void {
  const declared = declaredUncompressedSize(entry);
  if (typeof declared === "number" && declared > maxBytes) {
    fail("too-large");
  }
}

type ZipStreamLike = {
  on: (event: string, cb: (...args: unknown[]) => void) => ZipStreamLike;
  resume?: () => void;
  pause?: () => void;
};

type ZipStreamEntry = {
  async?: (type: "uint8array") => Promise<Uint8Array>;
  internalStream?: (type: string) => ZipStreamLike;
};

/**
 * Decompress entry bytes with a hard ceiling enforced *while* streaming.
 * Declared central-directory sizes can be forged; `async("uint8array")` would
 * fully allocate first. Prefer JSZip `internalStream` and abort mid-inflate.
 */
async function readZipBytesBounded(
  entry: ZipStreamEntry,
  maxBytes: number,
): Promise<Uint8Array> {
  assertEntrySize(entry, maxBytes);

  if (typeof entry.internalStream === "function") {
    return new Promise<Uint8Array>((resolve, reject) => {
      const chunks: Uint8Array[] = [];
      let total = 0;
      let settled = false;
      const failOnce = (error: unknown) => {
        if (settled) return;
        settled = true;
        reject(error instanceof Error ? error : new Error(String(error)));
      };
      try {
        const stream = entry.internalStream!("uint8array");
        stream.on("data", (data: unknown) => {
          if (settled) return;
          const chunk =
            data instanceof Uint8Array
              ? data
              : data instanceof ArrayBuffer
                ? new Uint8Array(data)
                : null;
          if (!chunk) return;
          total += chunk.byteLength;
          if (total > maxBytes) {
            try {
              stream.pause?.();
            } catch {
              // ignore
            }
            failOnce(new ImportError("too-large", safeMessage("too-large")));
            return;
          }
          chunks.push(chunk);
        });
        stream.on("error", (err: unknown) => {
          failOnce(err ?? new Error("zip stream error"));
        });
        stream.on("end", () => {
          if (settled) return;
          settled = true;
          if (total > maxBytes) {
            reject(new ImportError("too-large", safeMessage("too-large")));
            return;
          }
          const out = new Uint8Array(total);
          let offset = 0;
          for (const c of chunks) {
            out.set(c, offset);
            offset += c.byteLength;
          }
          resolve(out);
        });
        stream.resume?.();
      } catch (error) {
        failOnce(error);
      }
    });
  }

  // Fallback when internalStream is unavailable (still post-check length).
  if (typeof entry.async !== "function") {
    fail("invalid-zip");
  }
  const bytes = await entry.async!("uint8array");
  if (bytes.byteLength > maxBytes) {
    fail("too-large");
  }
  return bytes;
}

async function readZipTextBounded(
  entry: ZipStreamEntry,
  maxBytes: number,
): Promise<string> {
  const bytes = await readZipBytesBounded(entry, maxBytes);
  if (typeof TextDecoder !== "undefined") {
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  }
  let out = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    out += String.fromCharCode(...Array.from(bytes.subarray(i, i + step)));
  }
  return out;
}

/**
 * Reject archives whose declared per-entry or aggregate expansion exceeds limits.
 * Declared sizes can be forged; this is a best-effort pre-decompress gate only.
 */
function assertZipExpansionLimits(
  zip: JSZip,
  maxEntryBytes: number,
  maxTotalBytes: number,
): void {
  let total = 0;
  for (const path of Object.keys(zip.files)) {
    const entry = zip.files[path];
    if (!entry || entry.dir) continue;
    const declared = declaredUncompressedSize(entry);
    if (typeof declared !== "number") continue;
    if (declared > maxEntryBytes) {
      fail("too-large");
    }
    total += declared;
    if (total > maxTotalBytes) {
      fail("too-large");
    }
  }
}

function safeMessage(code: ImportError["code"]): string {
  switch (code) {
    case "missing-file":
      return "No file was selected.";
    case "too-large":
      return "The selected file is too large to import.";
    case "wrong-type":
      return "Only DRM-free EPUB files can be imported.";
    case "invalid-zip":
      return "The selected file is not a valid EPUB archive.";
    case "missing-container":
      return "The EPUB is missing its container metadata.";
    case "missing-package":
      return "The EPUB is missing its package document.";
    case "encrypted":
      return "Protected or encrypted EPUB files are not supported.";
    default:
      return "The selected file cannot be opened.";
  }
}

function fail(code: ImportError["code"]): never {
  throw new ImportError(code, safeMessage(code));
}

/**
 * Extract a simple Dublin Core text element from OPF XML without a full parser.
 * Avoids loading EPUB.js during import (WebKit + shell budget).
 */
function extractDcText(opfXml: string, localName: string): string | undefined {
  // Match both <dc:title> and <title xmlns="...dc..."> style tags.
  const patterns = [
    new RegExp(
      `<dc:${localName}\\b[^>]*>([\\s\\S]*?)</dc:${localName}>`,
      "i",
    ),
    new RegExp(
      `<(?:[A-Za-z_][\\w.-]*:)?${localName}\\b[^>]*>([\\s\\S]*?)</(?:[A-Za-z_][\\w.-]*:)?${localName}>`,
      "i",
    ),
  ];
  for (const pattern of patterns) {
    const match = opfXml.match(pattern);
    if (match?.[1]) {
      const text = decodeXmlEntities(match[1].replace(/<[^>]+>/g, "").trim());
      if (text) return text;
    }
  }
  return undefined;
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function packageSignalsEncryption(opfXml: string): boolean {
  if (/encryption/i.test(opfXml) && /EncryptedData|encryption\.xml/i.test(opfXml)) {
    return true;
  }
  // Manifest item properties="…encrypted…"
  if (/properties\s*=\s*["'][^"']*\bencrypted\b[^"']*["']/i.test(opfXml)) {
    return true;
  }
  return false;
}

/**
 * Validate a local EPUB envelope and extract package metadata.
 * Performs one full-file `arrayBuffer()` read and returns it as `epubBytes`
 * (plus a Blob wrapper for API compatibility). Uses JSZip only — no EPUB.js
 * on the import path (keeps the library shell lean and WebKit-compatible).
 */
export async function validateEpub(
  file: Blob | null | undefined,
  fileName: string,
  options: ValidateEpubOptions = {},
): Promise<ValidatedImport> {
  if (!file || typeof file.size !== "number") {
    fail("missing-file");
  }

  const maxBytes = options.maxBytes ?? MAX_EPUB_BYTES;
  const maxEntryBytes =
    options.maxEntryUncompressedBytes ?? MAX_ENTRY_UNCOMPRESSED_BYTES;
  const maxTotalBytes =
    options.maxTotalUncompressedBytes ?? MAX_TOTAL_UNCOMPRESSED_BYTES;
  // Match assessImport: block at threshold (inclusive), not only above it.
  if (file.size >= maxBytes) {
    fail("too-large");
  }

  const name = fileName || "book.epub";
  const mimeOk = isAcceptedMime(file.type);
  const extOk = hasEpubExtension(name);
  if (!mimeOk && !extOk) {
    fail("wrong-type");
  }

  if (!(await hasZipMagic(file))) {
    fail("invalid-zip");
  }

  let buffer: ArrayBuffer;
  try {
    buffer = await file.arrayBuffer();
  } catch {
    fail("invalid-zip");
  }

  try {
    assertZipStructure(buffer);
  } catch (error) {
    if (error instanceof ZipStructureException) {
      if (error.code === "zip64" || error.code === "too-many-entries") {
        fail("too-large");
      }
      if (error.code === "traversal" || error.code === "path-too-long") {
        fail("invalid-zip");
      }
      fail("invalid-zip");
    }
    throw error;
  }

  // Bounded structural checks with JSZip (container, encryption, package path).
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch {
    fail("invalid-zip");
  }

  // Best-effort ZIP bomb guard from central-directory declared sizes.
  assertZipExpansionLimits(zip, maxEntryBytes, maxTotalBytes);

  const encryption = zip.file("META-INF/encryption.xml");
  if (encryption) {
    try {
      const encXml = await readZipTextBounded(
        encryption,
        MAX_METADATA_ENTRY_BYTES,
      );
      if (shouldRejectEncryption(encXml)) {
        fail("encrypted");
      }
      // Font-obfuscation-only: allow import; reader uses system fonts if
      // deobfuscation is not implemented.
    } catch (error) {
      if (error instanceof ImportError) throw error;
      fail("encrypted");
    }
  }

  // Some DRM packages place rights.xml or META-INF encryption variants.
  if (zip.file("META-INF/rights.xml")) {
    // Presence alone is not always DRM, but combined with encryption already handled.
  }

  const containerFile = zip.file("META-INF/container.xml");
  if (!containerFile) {
    fail("missing-container");
  }

  let rootPath: string | undefined;
  try {
    assertEntrySize(containerFile, MAX_METADATA_ENTRY_BYTES);
    // Stream-bounded read so forged declared sizes cannot expand past ceiling.
    const containerXml = await readZipTextBounded(
      containerFile,
      MAX_METADATA_ENTRY_BYTES,
    );
    const match = containerXml.match(/full-path\s*=\s*["']([^"']+)["']/i);
    rootPath = match?.[1];
  } catch (error) {
    if (error instanceof ImportError) throw error;
    fail("missing-container");
  }

  if (!rootPath || !zip.file(rootPath)) {
    fail("missing-package");
  }

  const packageFile = zip.file(rootPath);
  if (!packageFile) {
    fail("missing-package");
  }

  let opfXml: string;
  try {
    assertEntrySize(packageFile, MAX_METADATA_ENTRY_BYTES);
    opfXml = await readZipTextBounded(packageFile, MAX_METADATA_ENTRY_BYTES);
  } catch (error) {
    if (error instanceof ImportError) throw error;
    fail("missing-package");
  }

  if (!opfXml || !/<package\b/i.test(opfXml)) {
    fail("missing-package");
  }

  if (packageSignalsEncryption(opfXml)) {
    fail("encrypted");
  }

  const title =
    extractDcText(opfXml, "title") ||
    name.replace(/\.epub$/i, "") ||
    "Untitled";
  const creator = extractDcText(opfXml, "creator");

  // Reuse the single validated buffer — avoid a second full-file read on import.
  const epubBlob = new Blob([buffer], { type: "application/epub+zip" });
  const validated: ValidatedImport = {
    fileName: name,
    epub: epubBlob,
    epubBytes: buffer,
    title,
  };
  if (creator !== undefined) {
    validated.creator = creator;
  }

  return validated;
}
