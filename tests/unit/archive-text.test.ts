import { describe, expect, it, vi } from "vitest";
import {
  readArchiveTextBounded,
  utf8ByteLength,
  type ArchiveZipEntry,
} from "../../src/reader/archive-text";
import type { AdaptedBook } from "../../src/reader/epub-adapter";

function makeBook(entry: ArchiveZipEntry | null, createUrl?: () => Promise<string>): AdaptedBook {
  const create = createUrl ?? vi.fn(async () => "blob:should-not-call");
  return {
    ready: Promise.resolve(),
    spine: {
      hooks: { content: { register() {}, deregister() {} } },
      get: () => null,
    },
    renderTo: () => {
      throw new Error("unused");
    },
    destroy() {},
    archive: {
      createUrl: create,
      zip: {
        file(path: string) {
          if (path.replace(/^\//, "").includes("style") || path.includes("css")) {
            return entry;
          }
          return null;
        },
      },
    },
  } as unknown as AdaptedBook;
}

describe("readArchiveTextBounded", () => {
  it("rejects declared size above maxBytes before streaming", async () => {
    const stream = vi.fn();
    const entry: ArchiveZipEntry = {
      uncompressedSize: 5 * 1024 * 1024,
      internalStream: stream as ArchiveZipEntry["internalStream"],
    };
    const createUrl = vi.fn(async () => "blob:x");
    const book = makeBook(entry, createUrl);
    const text = await readArchiveTextBounded(book, "styles/huge.css", 256 * 1024);
    expect(text).toBeNull();
    expect(stream).not.toHaveBeenCalled();
    expect(createUrl).not.toHaveBeenCalled();
  });

  it("aborts stream once actual bytes exceed maxBytes", async () => {
    const entry: ArchiveZipEntry = {
      // Forged small declared size
      uncompressedSize: 1,
      internalStream: () => {
        const handlers: Record<string, Array<(...a: unknown[]) => void>> = {};
        const stream = {
          on(event: string, cb: (...a: unknown[]) => void) {
            (handlers[event] ??= []).push(cb);
            return stream;
          },
          resume() {
            // Emit 300 KiB of data in chunks
            const chunk = new Uint8Array(100 * 1024);
            handlers.data?.forEach((cb) => cb(chunk));
            handlers.data?.forEach((cb) => cb(chunk));
            handlers.data?.forEach((cb) => cb(chunk));
            handlers.end?.forEach((cb) => cb());
          },
          pause() {},
        };
        return stream;
      },
    };
    const createUrl = vi.fn(async () => "blob:x");
    const book = makeBook(entry, createUrl);
    const text = await readArchiveTextBounded(book, "OEBPS/Styles/x.css", 256 * 1024);
    expect(text).toBeNull();
    expect(createUrl).not.toHaveBeenCalled();
  });

  it("returns decoded text for a small streamed entry", async () => {
    const payload = new TextEncoder().encode("p{color:red}");
    const entry: ArchiveZipEntry = {
      uncompressedSize: payload.byteLength,
      internalStream: () => {
        const handlers: Record<string, Array<(...a: unknown[]) => void>> = {};
        const stream = {
          on(event: string, cb: (...a: unknown[]) => void) {
            (handlers[event] ??= []).push(cb);
            return stream;
          },
          resume() {
            handlers.data?.forEach((cb) => cb(payload));
            handlers.end?.forEach((cb) => cb());
          },
          pause() {},
        };
        return stream;
      },
    };
    const createUrl = vi.fn(async () => "blob:x");
    const book = makeBook(entry, createUrl);
    const text = await readArchiveTextBounded(book, "styles/ok.css", 256 * 1024);
    expect(text).toBe("p{color:red}");
    expect(createUrl).not.toHaveBeenCalled();
  });

  it("utf8ByteLength counts multi-byte characters", () => {
    expect(utf8ByteLength("abc")).toBe(3);
    expect(utf8ByteLength("中")).toBe(3);
  });
});
