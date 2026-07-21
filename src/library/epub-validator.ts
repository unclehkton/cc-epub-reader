import JSZip from "jszip";
import { Book } from "epubjs";
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
 * Validate a local EPUB envelope and extract package metadata.
 * Returns the original Blob (no second full copy). Always destroys EPUB.js resources.
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

  // Pinned EPUB.js spike for packaging metadata.
  const book = new Book();
  try {
    await book.open(buffer, "binary");
    await book.ready;

    const packaging = book.packaging as
      | {
          metadata?: { title?: string; creator?: string };
          encryption?: unknown;
          manifest?: Record<string, { properties?: string }>;
        }
      | undefined;

    if (packaging?.encryption) {
      fail("encrypted");
    }

    // Some DRM EPUBs surface encryption properties on manifest items.
    const manifest = packaging?.manifest;
    if (manifest) {
      for (const item of Object.values(manifest)) {
        const props = item?.properties ?? "";
        if (
          typeof props === "string" &&
          props.toLowerCase().includes("encrypted")
        ) {
          fail("encrypted");
        }
      }
    }

    const title =
      (packaging?.metadata?.title && String(packaging.metadata.title).trim()) ||
      name.replace(/\.epub$/i, "") ||
      "Untitled";
    const creatorRaw = packaging?.metadata?.creator;
    const creator =
      creatorRaw !== undefined && String(creatorRaw).trim().length > 0
        ? String(creatorRaw).trim()
        : undefined;

    const result: ValidatedImport = {
      fileName: name,
      epub: file,
      title,
    };
    if (creator !== undefined) {
      result.creator = creator;
    }
    return result;
  } catch (error) {
    if (error instanceof ImportError) {
      throw error;
    }
    // Map EPUB.js structural failures without leaking payload text.
    const message = error instanceof Error ? error.message : "";
    if (/container/i.test(message)) {
      fail("missing-container");
    }
    if (/package|opf|rootfile/i.test(message)) {
      fail("missing-package");
    }
    fail("invalid-zip");
  } finally {
    try {
      book.destroy();
    } catch {
      // EPUB.js may throw during teardown in non-browser environments.
    }
  }
}
