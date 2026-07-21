import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_RENDITION_OPTIONS,
  purgeArchiveUrlCache,
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
  it("documents sandbox allow-scripts with chapter CSP as the script boundary", () => {
    // allowScriptedContent true is required for WebKit image-gate events;
    // package scripts are blocked by transformChapter CSP + sanitizer.
    expect(DEFAULT_RENDITION_OPTIONS.allowScriptedContent).toBe(true);
    const transformer = fs.readFileSync(
      path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        "../../src/reader/chapter-transformer.ts",
      ),
      "utf8",
    );
    expect(transformer).toMatch(/script-src 'none'/);
    expect(transformer).toMatch(/installChapterContentSecurityPolicy/);
  });

  it("uses replacements none rather than a falsy false that EPUB.js ignores", () => {
    const adapter = fs.readFileSync(adapterPath, "utf8");
    const session = fs.readFileSync(sessionPath, "utf8");
    expect(adapter).toMatch(/replacements === undefined \? "none"/);
    expect(adapter).not.toMatch(/replacements:\s*false/);
    expect(session).toMatch(/replacements:\s*"none"/);
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
});
