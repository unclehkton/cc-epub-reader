import { afterEach, describe, expect, it } from "vitest";
import { makeEpub } from "../helpers/make-epub";
import {
  createArchiveResolver,
  enforceNoArchiveReplacements,
  installNoArchiveReplacementsGuard,
  loadEpubFactory,
  materializeArchiveUrl,
  type AdaptedBook,
} from "../../src/reader/epub-adapter";
import { transformChapter } from "../../src/reader/chapter-transformer";

const TINY_PNG = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  ),
  (c) => c.charCodeAt(0),
);

const openBooks: AdaptedBook[] = [];

afterEach(() => {
  for (const book of openBooks.splice(0)) {
    try {
      book.destroy();
    } catch {
      // ignore
    }
  }
});

async function openBook(blob: Blob): Promise<AdaptedBook> {
  const factory = await loadEpubFactory();
  const buffer = await blob.arrayBuffer();
  const book = factory(buffer, { replacements: "none" });
  installNoArchiveReplacementsGuard(book);
  await book.ready;
  enforceNoArchiveReplacements(book);
  openBooks.push(book);
  return book;
}

async function loadSection(book: AdaptedBook, hrefFragment: string) {
  const items = book.spine.spineItems ?? [];
  const section = items.find((s) => String(s.href ?? "").includes(hrefFragment));
  expect(section).toBeTruthy();
  const anySection = section as {
    href?: string;
    load: (req?: unknown) => Promise<unknown>;
    document?: Document;
    url?: string;
  };
  if (!anySection.url) {
    anySection.url = `/${anySection.href ?? hrefFragment}`;
  }
  const loadFn = typeof book.load === "function" ? book.load.bind(book) : undefined;
  await anySection.load(loadFn);
  return anySection;
}

describe("nested Text/ + Images/ EPUB layout (Kindle/z-library)", () => {
  it("opens ../Images refs from Text/ chapters and materializes the ZIP image", async () => {
    const blob = await makeEpub({
      title: "Nested Images",
      chapters: [
        {
          id: "cover",
          href: "Text/cover.xhtml",
          title: "封面",
          body: `<div>
            <svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"
                 height="100%" width="100%" viewBox="0 0 800 1175">
              <image height="1175" width="800" xlink:href="../Images/photo.jpeg"/>
            </svg>
          </div>`,
        },
        {
          id: "ch",
          href: "Text/part0004.xhtml",
          title: "插圖",
          body: `<p class="center"><img alt="" src="../Images/photo.jpeg"/></p>`,
        },
      ],
      extraManifestItems: [
        {
          id: "img1",
          href: "Images/photo.jpeg",
          mediaType: "image/jpeg",
        },
      ],
      extraFiles: {
        "OEBPS/Images/photo.jpeg": TINY_PNG,
      },
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("blob:")) {
        return {
          blob: async () => new Blob([TINY_PNG], { type: "image/jpeg" }),
        } as Response;
      }
      if (typeof originalFetch === "function") {
        return originalFetch(input);
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch;

    try {
      const book = await openBook(blob);
      const urls = book.resources?.urls ?? [];
      expect(urls.join(" ")).toMatch(/Images\/photo\.jpeg/i);

      const cover = await loadSection(book, "cover.xhtml");
      const coverResolve = createArchiveResolver(
        book,
        undefined,
        cover.href,
      );
      transformChapter(cover.document!, coverResolve, {
        sectionHref: cover.href,
      });
      const svgImage = cover.document!.getElementsByTagName("image")[0];
      expect(svgImage?.getAttribute("data-epub-src")).toMatch(/Images\/photo\.jpeg$/);

      const chapter = await loadSection(book, "part0004.xhtml");
      const chapterResolve = createArchiveResolver(
        book,
        undefined,
        chapter.href,
      );
      transformChapter(chapter.document!, chapterResolve, {
        sectionHref: chapter.href,
      });
      const img = chapter.document!.getElementsByTagName("img")[0];
      expect(img?.getAttribute("src")).toBeNull();
      const stored = img?.getAttribute("data-epub-src");
      expect(stored).toMatch(/Images\/photo\.jpeg$/);

      const url = await materializeArchiveUrl(book, stored ?? "Images/photo.jpeg");
      expect(url).toMatch(/^blob:/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }, 30_000);
});
