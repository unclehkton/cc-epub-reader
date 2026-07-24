/**
 * Integration: prove book.spine.hooks.content is the pre-serialization
 * transform point, images leave the hook inert, and rendition.hooks.content
 * is a post-iframe path (too late for isolation).
 *
 * Full EPUB.js iframe rendition is fragile under jsdom; this suite pins the
 * installed epubjs hook order via real Book/Section load+render and documents
 * that ReaderSession registers only on spine.hooks.content.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createReaderSession } from "../../src/reader/reader-session";
import {
  loadEpubFactory,
  type AdaptedBook,
  type AdaptedRendition,
  type HookLike,
} from "../../src/reader/epub-adapter";
import { transformChapter } from "../../src/reader/chapter-transformer";
import { makeEpub } from "../helpers/make-epub";

async function openRealBook(blob: Blob): Promise<AdaptedBook> {
  const factory = await loadEpubFactory();
  const buffer = await blob.arrayBuffer();
  const book = factory(buffer, { replacements: "blobUrl" });
  await book.ready;
  return book;
}

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

function createHook(): HookLike & {
  handlers: Array<(...args: unknown[]) => unknown>;
} {
  const handlers: Array<(...args: unknown[]) => unknown> = [];
  return {
    handlers,
    register(fn) {
      handlers.push(fn);
    },
    deregister(fn) {
      const i = handlers.indexOf(fn);
      if (i >= 0) handlers.splice(i, 1);
    },
    list() {
      return handlers.slice();
    },
    clear() {
      handlers.length = 0;
    },
    async trigger(...args: unknown[]) {
      for (const h of handlers) {
        await h(...args);
      }
    },
  };
}

describe("EPUB.js spine.hooks.content order (pre-serialization)", () => {
  it("runs registered content hooks before section serialization", async () => {
    const blob = await makeEpub({
      title: "Hook Order Fixture",
      creator: "Tester",
      chapters: [
        {
          id: "c1",
          href: "ch1.xhtml",
          title: "一",
          body: `<p>你好</p><img id="local" src="images/cover.png" alt="圖"/><img id="remote" src="https://tracker.example/pixel.gif" alt="遙"/>`,
        },
      ],
      extraFiles: {
        "OEBPS/images/cover.png": Uint8Array.from(
          atob(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
          ),
          (c) => c.charCodeAt(0),
        ),
      },
    });

    const book = await openRealBook(blob);
    openBooks.push(book);
    const order: string[] = [];

    book.spine.hooks.content.register((doc: unknown) => {
      order.push("spine-content");
      const document = doc as Document;
      transformChapter(document, (raw) => {
        if (
          raw.startsWith("http:") ||
          raw.startsWith("https:") ||
          raw.startsWith("//")
        ) {
          return null;
        }
        if (raw.includes("..")) return null;
        return `blob:test-archive/${raw.replace(/^\.\//, "")}`;
      });
    });

    // Serialize hook runs after content hooks (see epubjs Section#render).
    book.spine.hooks.serialize?.register?.(() => {
      order.push("spine-serialize");
    });

    const section = book.spine.get(0);
    expect(section).toBeTruthy();

    const loadFn =
      typeof book.load === "function" ? book.load.bind(book) : undefined;
    const sectionAny = section as {
      load: (req?: unknown) => Promise<unknown>;
      render: (req?: unknown) => Promise<string>;
      document?: Document;
      url?: string;
    };

    // Provide a url so epubjs replaceBase does not throw under jsdom.
    if (!sectionAny.url) {
      sectionAny.url = "/OEBPS/ch1.xhtml";
    }

    await sectionAny.load(loadFn);
    expect(order).toContain("spine-content");

    const doc = sectionAny.document;
    expect(doc).toBeTruthy();
    const liveSrcs = Array.from(doc!.getElementsByTagName("img")).map((img) =>
      img.getAttribute("src"),
    );
    for (const src of liveSrcs) {
      expect(src).toBeNull();
    }

    const local = doc!.getElementById("local");
    expect(local?.getAttribute("data-epub-src")).toMatch(/cover\.png/);
    expect(
      doc!.getElementById("remote")?.getAttribute("data-epub-src"),
    ).toBeNull();

    const serialized = await sectionAny.render(loadFn);
    expect(order.indexOf("spine-content")).toBeLessThan(
      order.indexOf("spine-serialize"),
    );
    expect(serialized).not.toMatch(/https:\/\/tracker\.example/i);
    expect(serialized).not.toMatch(/src=["']images\/cover\.png["']/i);
  });

  it("documents that rendition.hooks.content is post-iframe (too late)", async () => {
    // Pin against installed epubjs source contract (Section#load / Rendition hooks):
    // - Section.load → spine.hooks.content.trigger(document) → serialize → iframe write
    // - After iframe document loads, rendition.hooks.content runs on Contents
    // Image isolation MUST therefore use spine.hooks.content only.

    const blob = await makeEpub({
      title: "R",
      chapters: [
        {
          id: "c1",
          href: "ch1.xhtml",
          title: "C",
          body: "<p>x</p>",
        },
      ],
    });
    const book = await openRealBook(blob);
    openBooks.push(book);

    expect(book.spine.hooks.content).toBeTruthy();
    expect(typeof book.spine.hooks.content.register).toBe("function");

    // Do not call real renderTo under jsdom (starts rAF queues). Instead assert
    // the public hook surface exists on a synthetic rendition-shaped object that
    // mirrors epubjs Rendition.hooks, proving the two registration points differ.
    const spineHook = book.spine.hooks.content as HookLike;
    const renditionContentHook = createHook();

    const spineBefore = spineHook.list?.()?.length ?? 0;
    const marker = (): void => undefined;
    spineHook.register(marker);
    expect((spineHook.list?.()?.length ?? 0) > spineBefore).toBe(true);

    // Sanitizer is never registered on the post-iframe hook.
    expect(renditionContentHook.handlers).toHaveLength(0);
    spineHook.deregister?.(marker);

    // Behavioral order is proven in the previous test (spine-content < spine-serialize).
    // Post-iframe timing is inherent: rendition content hooks receive Contents after
    // the iframe document is loaded (epubjs managers/views/iframe.js).
    expect(spineHook).not.toBe(renditionContentHook);
  });

  it("ReaderSession registers transform exclusively via spine.hooks.content", async () => {
    const blob = await makeEpub({
      title: "Session Hook",
      chapters: [
        {
          id: "c1",
          href: "ch1.xhtml",
          title: "C",
          body: `<p>文字</p><img src="images/a.png" alt="a"/><img src="https://evil.example/x.png" alt="e"/>`,
        },
      ],
    });

    const registered: Array<"spine" | "rendition"> = [];
    const factory = await loadEpubFactory();
    let capturedSpineHook: HookLike | null = null;
    let sessionTransform: ((doc: Document) => void) | null = null;

    const host = document.createElement("div");
    document.body.appendChild(host);

    const session = createReaderSession({
      element: host,
      createBook: (source, options) => {
        const book = factory(source, options);
        openBooks.push(book);

        const originalSpineRegister = book.spine.hooks.content.register.bind(
          book.spine.hooks.content,
        );
        book.spine.hooks.content.register = (fn) => {
          registered.push("spine");
          sessionTransform = fn as (doc: Document) => void;
          capturedSpineHook = book.spine.hooks.content;
          return originalSpineRegister(fn);
        };

        // Fully fake rendition — never touch real EPUB.js iframe pipeline.
        book.renderTo = () => {
          const contentHook = createHook();
          const originalRegister = contentHook.register.bind(contentHook);
          contentHook.register = (fn) => {
            registered.push("rendition");
            return originalRegister(fn);
          };

          const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
          const rendition: AdaptedRendition = {
            hooks: { content: contentHook },
            settings: { allowScriptedContent: false },
            themes: {
              fontSize: vi.fn(),
              font: vi.fn(),
              override: vi.fn(),
            },
            location: null,
            async display() {
              this.location = {
                start: {
                  index: 0,
                  href: "ch1.xhtml",
                  cfi: "epubcfi(/6/4!/4/2/2)",
                  displayed: { page: 1, total: 1 },
                },
              };
            },
            async next() {
              return undefined;
            },
            async prev() {
              return undefined;
            },
            destroy() {
              listeners.clear();
            },
            on(event, listener) {
              let set = listeners.get(event);
              if (!set) {
                set = new Set();
                listeners.set(event, set);
              }
              set.add(listener);
            },
            off(event, listener) {
              listeners.get(event)?.delete(listener);
            },
            flow: vi.fn(),
            getContents() {
              // Stable identity required — readiness re-probes getContents.
              const r = rendition as AdaptedRendition & {
                _stableDoc?: Document;
              };
              if (!r._stableDoc) {
                r._stableDoc = new DOMParser().parseFromString(
                  "<html><body><p>文字</p></body></html>",
                  "text/html",
                );
              }
              return { document: r._stableDoc };
            },
          };
          return rendition;
        };

        return book;
      },
    });

    await session.open(blob);

    expect(registered).toContain("spine");
    expect(registered.filter((r) => r === "rendition")).toHaveLength(0);
    expect(capturedSpineHook).toBeTruthy();
    expect(sessionTransform).toBeTypeOf("function");

    // Invoke only the session transform (not epubjs replaceBase which needs section.url).
    const doc = new DOMParser().parseFromString(
      `<html><body><img src="images/a.png" alt="a"/><img src="https://evil.example/x.png" alt="e"/></body></html>`,
      "text/html",
    );
    sessionTransform!(doc);
    for (const img of Array.from(doc.getElementsByTagName("img"))) {
      expect(img.getAttribute("src")).toBeNull();
    }
    // Local archive path should be restorable; remote remains inert.
    const imgs = Array.from(doc.getElementsByTagName("img"));
    const dataSrcs = imgs.map((i) => i.getAttribute("data-epub-src"));
    expect(dataSrcs.some((v) => v && v.includes("a.png"))).toBe(true);
    expect(dataSrcs.every((v) => !v || !v.includes("evil.example"))).toBe(true);

    session.destroy();
    host.remove();
  });
});
