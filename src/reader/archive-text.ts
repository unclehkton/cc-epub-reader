/**
 * Bounded archive text reader for package CSS and other small text assets.
 * Never uses createUrl / Blob — streams entry bytes and aborts past maxBytes.
 */

import type { AdaptedBook } from "./epub-adapter";

export interface ArchiveZipEntry {
  name?: string;
  async?: (type: string) => Promise<unknown>;
  uncompressedSize?: number;
  _data?: { uncompressedSize?: number };
  internalStream?: (type: string) => ArchiveEntryStream;
}

export interface ArchiveEntryStream {
  on(event: string, cb: (...args: unknown[]) => void): ArchiveEntryStream;
  resume?: () => void;
  pause?: () => void;
}

export interface ArchiveZipLike {
  file(path: string): ArchiveZipEntry | null | undefined;
}

function declaredUncompressedSize(entry: ArchiveZipEntry): number | undefined {
  if (typeof entry.uncompressedSize === "number") {
    return entry.uncompressedSize;
  }
  if (typeof entry._data?.uncompressedSize === "number") {
    return entry._data.uncompressedSize;
  }
  return undefined;
}

/** Resolve likely archive entry paths for a package-relative href. */
export function archivePathCandidates(
  packagePath: string,
  book?: AdaptedBook | null,
): string[] {
  const path = packagePath.trim();
  if (!path) return [];
  const raw = new Set<string>([path]);
  if (book && typeof book.resolve === "function") {
    try {
      const resolved = book.resolve(path);
      if (resolved) raw.add(resolved);
    } catch {
      // ignore
    }
  }
  if (!path.includes("/")) {
    raw.add(`styles/${path}`);
    raw.add(`Styles/${path}`);
    raw.add(`OEBPS/styles/${path}`);
    raw.add(`OEBPS/Styles/${path}`);
  } else if (!path.startsWith("OEBPS/")) {
    raw.add(`OEBPS/${path}`);
  }

  const out = new Set<string>();
  for (const c of raw) {
    const cleaned = c.replace(/^\/+/, "");
    out.add(cleaned);
    // Some archives store with leading slash internally.
    out.add(`/${cleaned}`);
  }
  return Array.from(out);
}

function getArchiveZip(book: AdaptedBook): ArchiveZipLike | null {
  const archive = book.archive as
    | { zip?: ArchiveZipLike }
    | undefined;
  if (archive?.zip && typeof archive.zip.file === "function") {
    return archive.zip;
  }
  return null;
}

function findEntry(
  zip: ArchiveZipLike,
  candidates: string[],
): ArchiveZipEntry | null {
  for (const candidate of candidates) {
    try {
      // epubjs getBlob strips leading slash then decodeURIComponent.
      const stripped = candidate.replace(/^\/+/, "");
      const decoded = (() => {
        try {
          return decodeURIComponent(stripped);
        } catch {
          return stripped;
        }
      })();
      for (const key of [stripped, decoded, candidate, `/${stripped}`]) {
        const entry = zip.file(key);
        if (entry) return entry;
      }
    } catch {
      // try next
    }
  }
  return null;
}

/**
 * Read a text archive entry with a hard uncompressed byte ceiling.
 * - Rejects when declared size exceeds maxBytes (before any inflate/stream).
 * - Streams via internalStream when available; aborts once actual bytes > max.
 * - Never calls createUrl or builds a Blob URL.
 */
export async function readArchiveTextBounded(
  book: AdaptedBook,
  packagePath: string,
  maxBytes: number,
): Promise<string | null> {
  if (maxBytes <= 0) return null;
  const zip = getArchiveZip(book);
  if (!zip) return null;

  const candidates = archivePathCandidates(packagePath, book);
  const entry = findEntry(zip, candidates);
  if (!entry) return null;

  const declared = declaredUncompressedSize(entry);
  if (typeof declared === "number" && declared > maxBytes) {
    return null;
  }

  // Prefer streaming so forged small declared sizes still abort at maxBytes.
  if (typeof entry.internalStream === "function") {
    try {
      const bytes = await streamEntryBounded(entry, maxBytes);
      if (!bytes) return null;
      return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    } catch {
      return null;
    }
  }

  // Fallback: async uint8array with post-check (still no createUrl/blob URL).
  // Prefer avoiding this for huge entries — declared check already ran.
  if (typeof entry.async === "function") {
    try {
      const raw = await entry.async("uint8array");
      if (!(raw instanceof Uint8Array)) return null;
      if (raw.byteLength > maxBytes) return null;
      return new TextDecoder("utf-8", { fatal: false }).decode(raw);
    } catch {
      return null;
    }
  }

  return null;
}

function streamEntryBounded(
  entry: ArchiveZipEntry,
  maxBytes: number,
): Promise<Uint8Array | null> {
  return new Promise((resolve, reject) => {
    const stream = entry.internalStream!("uint8array");
    const chunks: Uint8Array[] = [];
    let total = 0;
    let settled = false;

    const finish = (result: Uint8Array | null, error?: unknown) => {
      if (settled) return;
      settled = true;
      try {
        stream.pause?.();
      } catch {
        // ignore
      }
      if (error) reject(error);
      else resolve(result);
    };

    stream.on("data", (chunk: unknown) => {
      const part =
        chunk instanceof Uint8Array
          ? chunk
          : new Uint8Array(chunk as ArrayBuffer);
      total += part.byteLength;
      if (total > maxBytes) {
        finish(null);
        return;
      }
      chunks.push(part);
    });
    stream.on("error", (err: unknown) => {
      finish(null, err);
    });
    stream.on("end", () => {
      if (total > maxBytes) {
        finish(null);
        return;
      }
      const out = new Uint8Array(total);
      let offset = 0;
      for (const c of chunks) {
        out.set(c, offset);
        offset += c.byteLength;
      }
      finish(out);
    });
    try {
      stream.resume?.();
    } catch (err) {
      finish(null, err);
    }
  });
}

/** UTF-8 byte length of a string (for aggregate CSS budgets). */
export function utf8ByteLength(text: string): number {
  if (typeof TextEncoder !== "undefined") {
    return new TextEncoder().encode(text).byteLength;
  }
  // Fallback approximation
  let n = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code <= 0x7f) n += 1;
    else if (code <= 0x7ff) n += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      n += 4;
      i += 1;
    } else n += 3;
  }
  return n;
}
