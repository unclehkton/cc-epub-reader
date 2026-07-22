import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MAX_ENTRY_UNCOMPRESSED_BYTES } from "../../src/library/epub-validator";
import {
  DEFAULT_RENDITION_OPTIONS,
  enforceNoArchiveReplacements,
  installNoArchiveReplacementsGuard,
  materializeArchiveUrl,
  purgeArchiveUrlCache,
  purgeArchiveUrlCacheKeys,
  type AdaptedBook,
} from "../../src/reader/epub-adapter";

const adapterPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../src/reader/epub-adapter.ts",
);
const sessionPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../src/reader/reader-session.ts",
);

describe("EPUB security configuration", () => {
  it("disables scripted content on default rendition options", () => {
    expect(DEFAULT_RENDITION_OPTIONS.allowScriptedContent).toBe(false);
    const session = fs.readFileSync(sessionPath, "utf8");
    expect(session).toMatch(/allowScriptedContent:\s*false/);
    const transformer = fs.readFileSync(
      path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        "../../src/reader/chapter-transformer.ts",
      ),
      "utf8",
    );
    expect(transformer).toMatch(/script-src 'none'/);
  });

  it("uses replacements none rather than a falsy false that EPUB.js ignores", () => {
    const adapter = fs.readFileSync(adapterPath, "utf8");
    const session = fs.readFileSync(sessionPath, "utf8");
    expect(adapter).toMatch(/replacements === undefined \? "none"/);
    expect(adapter).not.toMatch(/replacements:\s*false/);
    expect(session).toMatch(/replacements:\s*"none"/);
    expect(adapter).toMatch(/enforceNoArchiveReplacements/);
    expect(adapter).toMatch(/installNoArchiveReplacementsGuard/);
    expect(session).toMatch(/installNoArchiveReplacementsGuard/);
    expect(session).toMatch(/enforceNoArchiveReplacements/);
  });

  it("installs the no-replacement guard before ready so CSS blobs cannot race", async () => {
    let cssCalls = 0;
    let replacementCalls = 0;
    const book = {
      settings: { replacements: "blobUrl" },
      resources: {
        settings: { replacements: "blobUrl" },
        urls: ["OEBPS/style.css"],
        replacementUrls: [],
        replaceCss: async () => {
          cssCalls += 1;
          return ["blob:css"];
        },
        replacements: async () => {
          replacementCalls += 1;
          return ["blob:asset"];
        },
      },
      replacements: async () => book,
    } as unknown as AdaptedBook;

    installNoArchiveReplacementsGuard(book);
    const anyBook = book as unknown as {
      settings: { replacements: string };
      replacements: () => Promise<unknown>;
      resources: {
        settings: { replacements: string };
        replaceCss: () => Promise<unknown>;
        replacements: () => Promise<unknown>;
      };
    };
    expect(anyBook.settings.replacements).toBe("none");
    expect(anyBook.resources.settings.replacements).toBe("none");
    await anyBook.replacements();
    await anyBook.resources.replaceCss();
    await anyBook.resources.replacements();
    expect(cssCalls).toBe(0);
    expect(replacementCalls).toBe(0);
  });

  it("purges revoked blob URLs from the archive urlCache", () => {
    const cache: Record<string, string> = {
      "OEBPS/images/a.png": "blob:keep-me",
      "OEBPS/images/b.png": "blob:drop-me",
    };
    const book = {
      archive: { urlCache: cache },
    } as AdaptedBook;
    purgeArchiveUrlCache(book, ["blob:drop-me"]);
    expect(cache["OEBPS/images/a.png"]).toBe("blob:keep-me");
    expect(cache["OEBPS/images/b.png"]).toBeUndefined();
  });

  it("purges cache keys after oversized blob rejection", async () => {
    const cache: Record<string, string> = {
      "/OEBPS/images/big.png": "blob:oversized",
    };
    const book = {
      archive: {
        urlCache: cache,
        createUrl: async () => "blob:oversized",
      },
    } as unknown as AdaptedBook;

    // Simulate oversize rejection path: revoke + purge by value and key.
    purgeArchiveUrlCache(book, ["blob:oversized"]);
    purgeArchiveUrlCacheKeys(book, ["/OEBPS/images/big.png"]);
    expect(cache["/OEBPS/images/big.png"]).toBeUndefined();
  });

  it("materializeArchiveUrl revokes late createUrl results after timeout", async () => {
    const revoked: string[] = [];
    const original = URL.revokeObjectURL;
    URL.revokeObjectURL = (u: string) => {
      revoked.push(u);
    };
    try {
      let resolveCreate!: (url: string) => void;
      const createDeferred = new Promise<string>((resolve) => {
        resolveCreate = resolve;
      });
      const cache: Record<string, string> = {};
      const book = {
        archive: {
          urlCache: cache,
          createUrl: async (path: string) => {
            const url = await createDeferred;
            cache[path] = url;
            return url;
          },
        },
      } as unknown as AdaptedBook;

      const pending = materializeArchiveUrl(book, "OEBPS/images/late.png");
      // Let the 4s timeout fire.
      await new Promise((r) => setTimeout(r, 4100));
      const result = await pending;
      expect(result).toBeNull();
      // Late resolution must not leak an unowned blob.
      resolveCreate("blob:late-orphan");
      await new Promise((r) => setTimeout(r, 20));
      expect(revoked).toContain("blob:late-orphan");
    } finally {
      URL.revokeObjectURL = original;
    }
  }, 15_000);

  it("materializeArchiveUrl fails closed when size-check fetch throws", async () => {
    const revoked: string[] = [];
    const originalRevoke = URL.revokeObjectURL;
    const originalFetch = globalThis.fetch;
    URL.revokeObjectURL = (u: string) => {
      revoked.push(u);
    };
    globalThis.fetch = (async () => {
      throw new Error("size-check unavailable");
    }) as typeof fetch;
    try {
      const cache: Record<string, string> = {};
      const book = {
        archive: {
          urlCache: cache,
          createUrl: async (path: string) => {
            const url = `blob:size-fail-${path}`;
            cache[path] = url;
            return url;
          },
        },
      } as unknown as AdaptedBook;

      const result = await materializeArchiveUrl(book, "OEBPS/images/a.png");
      expect(result).toBeNull();
      expect(revoked.length).toBeGreaterThan(0);
    } finally {
      URL.revokeObjectURL = originalRevoke;
      globalThis.fetch = originalFetch;
    }
  });

  it("materializeArchiveUrl rejects oversize blobs and purges cache", async () => {
    const revoked: string[] = [];
    const originalRevoke = URL.revokeObjectURL;
    const originalFetch = globalThis.fetch;
    URL.revokeObjectURL = (u: string) => {
      revoked.push(u);
    };
    globalThis.fetch = (async () =>
      ({
        blob: async () => ({ size: MAX_ENTRY_UNCOMPRESSED_BYTES + 1 }),
      }) as Response) as typeof fetch;
    try {
      const cache: Record<string, string> = {
        "/OEBPS/images/big.png": "blob:too-big",
      };
      const book = {
        archive: {
          urlCache: cache,
          createUrl: async () => "blob:too-big",
        },
      } as unknown as AdaptedBook;

      const result = await materializeArchiveUrl(book, "OEBPS/images/big.png");
      expect(result).toBeNull();
      expect(revoked).toContain("blob:too-big");
    } finally {
      URL.revokeObjectURL = originalRevoke;
      globalThis.fetch = originalFetch;
    }
  });

  it("enforceNoArchiveReplacements clears eager blob maps and no-ops replacements()", async () => {
    const revoked: string[] = [];
    const original = URL.revokeObjectURL;
    URL.revokeObjectURL = (u: string) => {
      revoked.push(u);
    };
    try {
      let replacementsCalled = 0;
      const book = {
        settings: { replacements: "blobUrl" },
        resources: {
          settings: { replacements: "blobUrl" },
          replacementUrls: ["blob:eager-1", "blob:eager-2"],
        },
        archive: {
          urlCache: { "/OEBPS/a.png": "blob:eager-1" },
        },
        replacements: async () => {
          replacementsCalled += 1;
          return book;
        },
      } as unknown as AdaptedBook;

      enforceNoArchiveReplacements(book);

      const anyBook = book as AdaptedBook & {
        settings: { replacements: string };
        resources: {
          settings: { replacements: string };
          replacementUrls: string[];
        };
        replacements: () => Promise<unknown>;
      };
      expect(anyBook.settings.replacements).toBe("none");
      expect(anyBook.resources.settings.replacements).toBe("none");
      expect(anyBook.resources.replacementUrls).toEqual([]);
      expect(anyBook.archive?.urlCache?.["/OEBPS/a.png"]).toBeUndefined();
      expect(revoked).toEqual(
        expect.arrayContaining(["blob:eager-1", "blob:eager-2"]),
      );
      await anyBook.replacements();
      expect(replacementsCalled).toBe(0);
    } finally {
      URL.revokeObjectURL = original;
    }
  });
});
