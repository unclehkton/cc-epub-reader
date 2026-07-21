import JSZip from "jszip";
import type { ValidatedImport } from "../domain/types";
import { ImportError } from "./import-errors";

export const MAX_EPUB_BYTES = 100 * 1024 * 1024;

const ZIP_LOCAL_FILE_HEADER = [0x50, 0x4b, 0x03, 0x04] as const;
const ACCEPTED_MIME = new Set([
  "application/epub+zip",
  "application/zip",
  "application/x-zip-compressed",
]);

export interface ValidateEpubOptions {
  maxBytes?: number;
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
 * Returns the original Blob (no second full copy). Uses JSZip only — no EPUB.js
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
  if (file.size > maxBytes) {
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

  // Bounded structural checks with JSZip (container, encryption, package path).
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch {
    fail("invalid-zip");
  }

  const encryption = zip.file("META-INF/encryption.xml");
  if (encryption) {
    fail("encrypted");
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
    const containerXml = await containerFile.async("text");
    const match = containerXml.match(/full-path\s*=\s*["']([^"']+)["']/i);
    rootPath = match?.[1];
  } catch {
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
    opfXml = await packageFile.async("text");
  } catch {
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

  const validated: ValidatedImport = {
    fileName: name,
    epub: file,
    title,
  };
  if (creator !== undefined) {
    validated.creator = creator;
  }

  return validated;
}
