import { describe, expect, it } from "vitest";
import {
  buildArchiveUrlMap,
  createArchiveResolver,
  materializeArchiveUrl,
  type AdaptedBook,
} from "../../src/reader/epub-adapter";
import { transformChapter } from "../../src/reader/chapter-transformer";

/** 1×1 JPEG. */
const TINY_JPEG = Uint8Array.from(
  atob(
    "/9j/4AAQSkZJRgABAQAAAQABAAD/2wAAAAD/wAALCAABAAEBAREA/8QAFQABAQAAAAAAAAAAAAAAAAAAAAb/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAA/ALf/2Q==",
  ),
  (c) => c.charCodeAt(0),
);

function parseXhtml(xml: string): Document {
  return new DOMParser().parseFromString(xml, "application/xhtml+xml");
}

function bookWithResources(
  urls: string[],
  zipNames: string[] = urls.map((u) => (u.startsWith("OEBPS/") ? u : `OEBPS/${u}`)),
): AdaptedBook {
  const zipSet = new Set(zipNames);
  const urlCache: Record<string, string> = {};
  const createCalls: string[] = [];
  const book = {
    ready: Promise.resolve(),
    spine: {
      hooks: { content: { register() {}, deregister() {} } },
      get: () => null,
    },
    resources: { urls },
    archive: {
      urlCache,
      createUrl: async (url: string) => {
        createCalls.push(url);
        // Mirror epubjs Archive.getBlob: decodeURIComponent(url.substr(1)).
        const decoded = decodeURIComponent(url.slice(1));
        if (!zipSet.has(decoded)) {
          throw new Error(`File not found in the epub: ${url}`);
        }
        const blob = new Blob([TINY_JPEG], { type: "image/jpeg" });
        const objectUrl = URL.createObjectURL(blob);
        urlCache[url] = objectUrl;
        return objectUrl;
      },
    },
    resolve: (path: string) => {
      const cleaned = path.replace(/^\//, "");
      if (cleaned.startsWith("OEBPS/")) return `/${cleaned}`;
      return `/OEBPS/${cleaned}`;
    },
    renderTo: () => {
      throw new Error("unused");
    },
    destroy() {},
    createCalls,
  };
  return book as unknown as AdaptedBook & { createCalls: string[] };
}

describe("Kindle-style nested Images/ paths", () => {
  it("resolves section-relative ../Images/*.jpeg against OPF Images/ hrefs", () => {
    const book = bookWithResources(["Images/image00493.jpeg"]);
    const resolve = createArchiveResolver(book, undefined, "Text/part0004.xhtml");
    expect(resolve("../Images/image00493.jpeg")).toBe("Images/image00493.jpeg");
    expect(resolve("Images/image00493.jpeg")).toBe("Images/image00493.jpeg");
  });

  it("aliases capital Images/ the same way as lowercase images/", () => {
    const book = bookWithResources(["Images/cover00569.jpeg"]);
    const map = buildArchiveUrlMap(book);
    expect(map.get("Images/cover00569.jpeg")).toBe("Images/cover00569.jpeg");
    expect(map.get("images/cover00569.jpeg")).toBe("Images/cover00569.jpeg");
    expect(map.get("cover00569.jpeg")).toBe("Images/cover00569.jpeg");
  });

  it("gates XHTML SVG xlink:href=../Images/*.jpeg before serialization", () => {
    const book = bookWithResources(["Images/image00490.jpeg"]);
    const resolve = createArchiveResolver(book, undefined, "Text/part0000.xhtml");
    const doc = parseXhtml(`<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" lang="zh-CN">
  <body>
    <svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"
         height="100%" width="100%" viewBox="0 0 800 1175">
      <image height="1175" width="800" xlink:href="../Images/image00490.jpeg"/>
    </svg>
  </body>
</html>`);

    transformChapter(doc, resolve, { sectionHref: "Text/part0000.xhtml" });

    const image = doc.getElementsByTagName("image")[0]!;
    expect(image.getAttribute("href")).toBeNull();
    expect(image.getAttribute("xlink:href")).toBeNull();
    expect(
      image.getAttributeNS("http://www.w3.org/1999/xlink", "href"),
    ).toBeNull();
    expect(image.getAttribute("data-epub-src")).toBe("Images/image00490.jpeg");
    const button = Array.from(doc.getElementsByTagName("button")).find(
      (b) => b.textContent?.trim() === "點擊顯示圖片",
    );
    expect(button).toBeTruthy();
  });

  it("gates XHTML img src=../Images/*.jpeg behind the reveal control", () => {
    const book = bookWithResources(["Images/image00493.jpeg"]);
    const resolve = createArchiveResolver(book, undefined, "Text/part0004.xhtml");
    const doc = parseXhtml(`<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" lang="zh-CN">
  <body>
    <p class="center">
      <img alt="" src="../Images/image00493.jpeg"/>
    </p>
  </body>
</html>`);

    transformChapter(doc, resolve, { sectionHref: "Text/part0004.xhtml" });

    const img = doc.getElementsByTagName("img")[0]!;
    expect(img.getAttribute("src")).toBeNull();
    expect(img.getAttribute("data-epub-src")).toBe("Images/image00493.jpeg");
    expect(img.previousElementSibling?.textContent?.trim()).toBe("點擊顯示圖片");
  });

  it("materializes OEBPS/Images/*.jpeg through epubjs leading-slash ZIP lookup", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("blob:")) {
        return {
          blob: async () => new Blob([TINY_JPEG], { type: "image/jpeg" }),
        } as Response;
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch;

    try {
      const book = bookWithResources(["Images/image00493.jpeg"], [
        "OEBPS/Images/image00493.jpeg",
      ]);
      const url = await materializeArchiveUrl(book, "Images/image00493.jpeg");
      expect(url).toMatch(/^blob:/);
      const calls = (book as unknown as { archive: { createUrl: unknown }; createCalls?: string[] })
        .createCalls;
      // The successful lookup must be the epubjs form: leading slash + ZIP path.
      expect(calls?.some((c) => c === "/OEBPS/Images/image00493.jpeg")).toBe(
        true,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
