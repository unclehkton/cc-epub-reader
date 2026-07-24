/**
 * Bounded archive text reader for package CSS and other small text assets.
 * Never uses createUrl / Blob — streams entry bytes and aborts past maxBytes
 * or wall-clock timeout. Fail closed when internalStream is unavailable
 * (async full-entry load would allocate unbounded).
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

export interface ReadArchiveTextOptions {
  maxBytes: number;
  /** Wall-clock deadline for the stream (ms). */
  timeoutMs?: number;
  signal?: AbortSignal;
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
    out.add(`/${cleaned}`);
  }
  return Array.from(out);
}

function getArchiveZip(book: AdaptedBook): ArchiveZipLike | null {
  const archive = book.archive as { zip?: ArchiveZipLike } | undefined;
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

function normalizeOptions(
  maxBytesOrOptions: number | ReadArchiveTextOptions,
): ReadArchiveTextOptions {
  if (typeof maxBytesOrOptions === "number") {
    return { maxBytes: maxBytesOrOptions };
  }
  return maxBytesOrOptions;
}

/**
 * Read a text archive entry with hard byte + wall-clock ceilings.
 * - Declared size over maxBytes → null before stream starts
 * - Stream aborts when actual bytes > maxBytes
 * - Stream aborts on timeoutMs / AbortSignal (pause + release chunks)
 * - No createUrl; no entry.async full inflate (fail closed without stream)
 */
export async function readArchiveTextBounded(
  book: AdaptedBook,
  packagePath: string,
  maxBytesOrOptions: number | ReadArchiveTextOptions,
): Promise<string | null> {
  const options = normalizeOptions(maxBytesOrOptions);
  const maxBytes = options.maxBytes;
  if (maxBytes <= 0) return null;
  if (options.signal?.aborted) return null;

  const zip = getArchiveZip(book);
  if (!zip) return null;

  const candidates = archivePathCandidates(packagePath, book);
  const entry = findEntry(zip, candidates);
  if (!entry) return null;

  const declared = declaredUncompressedSize(entry);
  if (typeof declared === "number" && declared > maxBytes) {
    return null;
  }

  // Fail closed: without internalStream we would need full entry.async inflate.
  if (typeof entry.internalStream !== "function") {
    return null;
  }

  try {
    const bytes = await streamEntryBounded(entry, {
      maxBytes,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
    });
    if (!bytes) return null;
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  } catch {
    return null;
  }
}

function streamEntryBounded(
  entry: ArchiveZipEntry,
  options: {
    maxBytes: number;
    timeoutMs?: number;
    signal?: AbortSignal;
  },
): Promise<Uint8Array | null> {
  const { maxBytes, timeoutMs, signal } = options;
  return new Promise((resolve) => {
    let stream: ArchiveEntryStream;
    try {
      stream = entry.internalStream!("uint8array");
    } catch {
      resolve(null);
      return;
    }

    const chunks: Uint8Array[] = [];
    let total = 0;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const releaseChunks = () => {
      chunks.length = 0;
      total = 0;
    };

    const finish = (result: Uint8Array | null) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      if (signal && onAbort) {
        try {
          signal.removeEventListener("abort", onAbort);
        } catch {
          // ignore
        }
      }
      try {
        stream.pause?.();
      } catch {
        // ignore
      }
      if (result == null) {
        releaseChunks();
      }
      resolve(result);
    };

    const onAbort = () => {
      finish(null);
    };

    if (typeof timeoutMs === "number" && timeoutMs >= 0) {
      timer = setTimeout(() => {
        finish(null);
      }, timeoutMs);
    }

    if (signal) {
      if (signal.aborted) {
        finish(null);
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }

    stream.on("data", (chunk: unknown) => {
      if (settled) return;
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
    stream.on("error", () => {
      finish(null);
    });
    stream.on("end", () => {
      if (settled) return;
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
      releaseChunks();
      finish(out);
    });
    try {
      stream.resume?.();
    } catch {
      finish(null);
    }
  });
}

/** UTF-8 byte length of a string (for aggregate CSS budgets). */
export function utf8ByteLength(text: string): number {
  if (typeof TextEncoder !== "undefined") {
    return new TextEncoder().encode(text).byteLength;
  }
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
