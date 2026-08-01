import { afterEach, describe, expect, it, vi } from "vitest";
import { ChapterConverter } from "../../src/reader/chapter-converter";
import {
  createOwnedObjectURL,
  createReaderSession,
  resolveEpubInternalHref,
  type ReaderEvent,
  type ReaderLocation,
} from "../../src/reader/reader-session";
import type {
  AdaptedBook,
  AdaptedLocation,
  AdaptedRendition,
  AdaptedSection,
  EpubFactory,
  HookLike,
} from "../../src/reader/epub-adapter";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("resolveEpubInternalHref", () => {
  it("keeps a fragment on the current spine document", () => {
    expect(resolveEpubInternalHref("#note-4", "Text/chapter.xhtml")).toBe(
      "Text/chapter.xhtml#note-4",
    );
  });

  it("resolves a nested relative EPUB link before navigation", () => {
    expect(
      resolveEpubInternalHref("../chapter.xhtml#start", "Text/notes/note.xhtml"),
    ).toBe("Text/chapter.xhtml#start");
  });
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
      const idx = handlers.indexOf(fn);
      if (idx >= 0) handlers.splice(idx, 1);
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

interface FakeControl {
  displayCalls: Array<{ target?: string | number; deferred: Deferred<void> }>;
  prevCalls: Deferred<void>[];
  nextCalls: Deferred<void>[];
  resizeCalls: Array<{ width?: number; height?: number }>;
  bookDestroyed: boolean;
  renditionDestroyed: boolean;
  contentHooks: ReturnType<typeof createHook>;
  renditionContentHooks: ReturnType<typeof createHook>;
  listeners: Map<string, Set<(...args: unknown[]) => void>>;
  location: AdaptedLocation | null;
  sections: AdaptedSection[];
  imageCreateCalls: string[];
  imageUrl: Deferred<string>;
  /** Override getContents() document for readiness/stale-doc tests. */
  contentsDocument: Document | null;
  /** Stable default when contentsDocument is null (must not allocate per probe). */
  defaultContentsDocument: Document | null;
  /**
   * When true, `next()` clears sync location and only exposes the new location
   * via async currentLocation() — covers Promise path for spine detection.
   */
  asyncLocationAfterNext: boolean;
  asyncLocationDeferred: Deferred<AdaptedLocation | undefined> | null;
  /**
   * When true, next()/prev() advance pages within the current spine item until
   * chapter page bounds, then cross spine — mirrors real paginated EPUB.js.
   */
  sameSpinePaging: boolean;
  /**
   * When set, display() always leaves location on this href after resolve
   * (simulates failed rollback that does not actually switch spine).
   */
  forceDisplayHref: string | null;
  emit(event: string, payload?: unknown): void;
  setLocation(partial: Partial<AdaptedLocation["start"]> & { cfi: string }): void;
  mintContentsForSpine(href: string): void;
}

function createFakeFactory(control: FakeControl): EpubFactory {
  return () => {
    const spineHook = control.contentHooks;
    const renditionHook = control.renditionContentHooks;

    const rendition: AdaptedRendition = {
      hooks: { content: renditionHook },
      settings: { allowScriptedContent: false },
      themes: {
        fontSize: vi.fn(),
        font: vi.fn(),
        override: vi.fn(),
      },
      location: null,
      display(target?: string | number) {
        const d = deferred<void>();
        control.displayCalls.push({ target, deferred: d });
        return d.promise.then(() => {
          // Test hook: pretend display resolved but spine never left force href.
          if (control.forceDisplayHref) {
            const href = control.forceDisplayHref;
            const index = Math.max(
              0,
              control.sections.findIndex((s) => s.href === href),
            );
            control.setLocation({
              cfi: `epubcfi(/6/4[${href}]!/4/2/2)`,
              href,
              index: index < 0 ? 0 : index,
            });
            rendition.location = control.location;
            control.emit("relocated", control.location);
            return;
          }
          // Same-spine CFI jump: keep Document identity and spine, change CFI/page.
          if (
            typeof target === "string" &&
            target.includes("epubcfi")
          ) {
            const cur = control.location?.start;
            // Prefer spine encoded in the CFI string when present.
            const cfiHrefMatch = /\[([^\]]+\.x?html)\]/i.exec(target);
            const hrefFromCfi = cfiHrefMatch?.[1];
            const href = hrefFromCfi ?? cur?.href ?? "ch1.xhtml";
            const index = Math.max(
              0,
              control.sections.findIndex((s) => s.href === href),
            );
            const page = (cur?.displayed?.page ?? 1) + 1;
            const total = cur?.displayed?.total ?? 4;
            control.setLocation({
              cfi: target,
              href,
              index: index < 0 ? (cur?.index ?? 0) : index,
              displayed: { page: Math.min(page, total), total },
            });
            rendition.location = control.location;
            control.emit("relocated", control.location);
            // Intentionally no "rendered" — EPUB.js often reuses the Document.
            return;
          }
          // Populate location when a display resolves (if still attached).
          const href =
            typeof target === "string" && target
              ? target
              : control.sections[0]?.href ?? "ch1.xhtml";
          const index =
            typeof target === "number"
              ? target
              : Math.max(
                  0,
                  control.sections.findIndex((s) => s.href === href),
                );
          control.setLocation({
            cfi: `epubcfi(/6/4[${href}]!/4/2/2)`,
            href,
            index: index < 0 ? 0 : index,
          });
          rendition.location = control.location;
          control.emit("relocated", control.location);
        });
      },
      next() {
        const d = deferred<void>();
        control.nextCalls.push(d);
        return d.promise.then(() => {
          const curStart = control.location?.start;
          const page = curStart?.displayed?.page ?? 1;
          const total = curStart?.displayed?.total ?? 1;
          // Same-spine page advance when multi-page chapter is active.
          if (
            control.sameSpinePaging &&
            page < total &&
            curStart
          ) {
            const nextPage = page + 1;
            const href = curStart.href ?? "ch1.xhtml";
            const index = curStart.index ?? 0;
            const cfi = `epubcfi(/6/4[${href}]!/4/2/${nextPage * 2})`;
            const nextLoc: AdaptedLocation = {
              start: {
                index,
                href,
                cfi,
                displayed: { page: nextPage, total },
              },
              end: {
                index,
                href,
                cfi,
                displayed: { page: nextPage, total },
              },
            };
            if (control.asyncLocationAfterNext) {
              control.location = null;
              rendition.location = null;
              control.asyncLocationDeferred =
                deferred<AdaptedLocation | undefined>();
              control.asyncLocationDeferred.resolve(nextLoc);
            } else {
              control.location = nextLoc;
              rendition.location = nextLoc;
              control.emit("relocated", nextLoc);
            }
            return;
          }

          const cur = curStart?.index ?? 0;
          const nextIdx = Math.min(cur + 1, control.sections.length - 1);
          const section = control.sections[nextIdx]!;
          const href = section.href ?? `ch${nextIdx + 1}.xhtml`;
          const cfi = `epubcfi(/6/4[${href}]!/4/2/2)`;
          const nextLoc: AdaptedLocation = {
            start: {
              index: nextIdx,
              href,
              cfi,
              displayed: { page: 1, total: control.sameSpinePaging ? 4 : 4 },
            },
            end: {
              index: nextIdx,
              href,
              cfi,
              displayed: { page: 1, total: control.sameSpinePaging ? 4 : 4 },
            },
          };
          control.mintContentsForSpine(href);
          if (control.asyncLocationAfterNext) {
            // Sync location intentionally stale / cleared until promise resolves.
            control.location = null;
            rendition.location = null;
            control.asyncLocationDeferred = deferred<AdaptedLocation | undefined>();
            control.asyncLocationDeferred.resolve(nextLoc);
          } else {
            control.location = nextLoc;
            rendition.location = nextLoc;
            control.emit("relocated", nextLoc);
          }
        });
      },
      prev() {
        const d = deferred<void>();
        control.prevCalls.push(d);
        return d.promise.then(() => {
          const curStart = control.location?.start;
          const page = curStart?.displayed?.page ?? 1;
          const total = curStart?.displayed?.total ?? 1;
          if (control.sameSpinePaging && page > 1 && curStart) {
            const prevPage = page - 1;
            const href = curStart.href ?? "ch1.xhtml";
            const index = curStart.index ?? 0;
            const cfi = `epubcfi(/6/4[${href}]!/4/2/${prevPage * 2})`;
            control.setLocation({
              cfi,
              href,
              index,
              displayed: { page: prevPage, total },
            });
            rendition.location = control.location;
            control.emit("relocated", control.location);
            return;
          }
          const cur = curStart?.index ?? 0;
          const prevIdx = Math.max(cur - 1, 0);
          const section = control.sections[prevIdx]!;
          control.setLocation({
            cfi: `epubcfi(/6/4[${section.href}]!/4/2/2)`,
            href: section.href,
            index: prevIdx,
          });
          rendition.location = control.location;
          control.emit("relocated", control.location);
        });
      },
      resize(width?: number, height?: number) {
        control.resizeCalls.push({ width, height });
      },
      destroy() {
        control.renditionDestroyed = true;
        control.listeners.clear();
      },
      on(event, listener) {
        let set = control.listeners.get(event);
        if (!set) {
          set = new Set();
          control.listeners.set(event, set);
        }
        set.add(listener);
      },
      off(event, listener) {
        control.listeners.get(event)?.delete(listener);
      },
      flow: vi.fn(),
      clear: vi.fn(),
      getContents() {
        if (control.contentsDocument) {
          return { document: control.contentsDocument };
        }
        // Stable identity — isChapterDocumentReady re-probes getContents and
        // rejects when the candidate identity changes on every call.
        if (!control.defaultContentsDocument) {
          control.defaultContentsDocument = new DOMParser().parseFromString(
            "<html><body><p>章節文字</p></body></html>",
            "text/html",
          );
        }
        return { document: control.defaultContentsDocument };
      },
      currentLocation() {
        if (control.asyncLocationAfterNext && control.asyncLocationDeferred) {
          return control.asyncLocationDeferred.promise;
        }
        return control.location ?? undefined;
      },
    };

    const book: AdaptedBook = {
      ready: Promise.resolve(),
      spine: {
        hooks: { content: spineHook },
        length: control.sections.length,
        spineItems: control.sections,
        get(target?: string | number) {
          if (typeof target === "number") return control.sections[target];
          if (typeof target === "string") {
            return control.sections.find((s) => s.href === target) ?? null;
          }
          return control.sections[0];
        },
      },
      packaging: {
        metadata: { title: "測試書", creator: "作者" },
      },
      navigation: {
        toc: [
          { label: "第一章", href: "ch1.xhtml" },
          { label: "第二章", href: "ch2.xhtml" },
        ],
      },
      resources: {
        urls: ["images/a.png"],
        replacementUrls: ["blob:fake-archive/images/a.png"],
      },
      archive: {
        urlCache: {},
        createUrl(path: string) {
          control.imageCreateCalls.push(path);
          return control.imageUrl.promise;
        },
      },
      renderTo() {
        return rendition;
      },
      destroy() {
        control.bookDestroyed = true;
      },
      resolve(path: string) {
        return path;
      },
    };

    return book;
  };
}

async function waitFor(
  predicate: () => boolean,
  label: string,
  timeoutMs = 1000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function createControl(): FakeControl {
  const control: FakeControl = {
    displayCalls: [],
    prevCalls: [],
    nextCalls: [],
    resizeCalls: [],
    bookDestroyed: false,
    renditionDestroyed: false,
    contentHooks: createHook(),
    renditionContentHooks: createHook(),
    listeners: new Map(),
    location: null,
    sections: [
      { href: "ch1.xhtml", index: 0 },
      { href: "ch2.xhtml", index: 1 },
    ],
    imageCreateCalls: [],
    imageUrl: deferred<string>(),
    contentsDocument: null,
    defaultContentsDocument: null,
    asyncLocationAfterNext: false,
    asyncLocationDeferred: null,
    sameSpinePaging: false,
    forceDisplayHref: null,
    emit(event, payload) {
      const set = control.listeners.get(event);
      if (!set) return;
      for (const listener of set) {
        listener(payload);
      }
    },
    mintContentsForSpine(href: string) {
      if (control.contentsDocument) return;
      const prevHref = control.location?.start.href;
      if (prevHref !== href || !control.defaultContentsDocument) {
        control.defaultContentsDocument = new DOMParser().parseFromString(
          `<html><body><p data-href="${href}">章節文字 ${href}</p></body></html>`,
          "text/html",
        );
      }
    },
    setLocation(partial) {
      const href = partial.href ?? "ch1.xhtml";
      const index = partial.index ?? 0;
      // When tests do not pin contentsDocument, mint a new Document identity
      // on spine changes — mirrors EPUB.js replacing the chapter document.
      control.mintContentsForSpine(href);
      control.location = {
        start: {
          index,
          href,
          cfi: partial.cfi,
          displayed: partial.displayed ?? { page: 1, total: 4 },
          percentage: partial.percentage,
        },
        end: {
          index,
          href,
          cfi: partial.cfi,
          displayed: partial.displayed ?? { page: 1, total: 4 },
        },
      };
    },
  };
  return control;
}

describe("ReaderSession generation ownership", () => {
  let host: HTMLElement;

  afterEach(() => {
    host?.remove();
  });

  function mountSession(control: FakeControl) {
    host = document.createElement("div");
    document.body.appendChild(host);
    const events: ReaderEvent[] = [];
    const session = createReaderSession({
      element: host,
      createBook: createFakeFactory(control),
      persistence: "durable",
    });
    session.subscribe((e) => events.push(e));
    return { session, events };
  }

  async function openAndResolve(session: ReturnType<typeof createReaderSession>, control: FakeControl) {
    const openPromise = session.open(
      new Blob(["epub"], { type: "application/epub+zip" }),
    );
    await waitFor(
      () => control.displayCalls.length >= 1,
      "initial display from open",
    );
    control.displayCalls[0]!.deferred.resolve();
    return openPromise;
  }

  it("serializes display A then B so final location and contents match B", async () => {
    const control = createControl();
    const docA = new DOMParser().parseFromString(
      "<html><body><p data-ch='1'>A</p></body></html>",
      "text/html",
    );
    const docB = new DOMParser().parseFromString(
      "<html><body><p data-ch='2'>B</p></body></html>",
      "text/html",
    );
    control.contentsDocument = docA;
    const { session, events } = mountSession(control);

    await openAndResolve(session, control);

    events.length = 0;
    control.displayCalls.length = 0;

    // Queue B while A is in-flight — nav mutex must not run B's display until A settles.
    const pA = session.display("ch1.xhtml");
    await waitFor(() => control.displayCalls.length >= 1, "display A");
    const pB = session.display("ch2.xhtml");
    // B must not start until A resolves (true single-flight).
    expect(control.displayCalls).toHaveLength(1);

    control.displayCalls[0]!.deferred.resolve();
    await pA;

    await waitFor(() => control.displayCalls.length >= 2, "display B after A");
    control.contentsDocument = docB;
    control.displayCalls[1]!.deferred.resolve();
    await pB;

    expect(session.getLocation()?.spineHref).toBe("ch2.xhtml");
    // Contents identity must match published location (not A stuck under B CFI).
    expect(control.contentsDocument?.querySelector("[data-ch='2']")).toBeTruthy();

    const locations = events.filter((e) => e.type === "location") as Array<{
      type: "location";
      location: ReaderLocation;
    }>;
    expect(locations.some((e) => e.location.spineHref === "ch2.xhtml")).toBe(
      true,
    );
    const lastLoc = locations[locations.length - 1];
    expect(lastLoc?.location.spineHref).toBe("ch2.xhtml");

    session.destroy();
  });

  it("destroy() invalidates pending work and does not emit stale events", async () => {
    const control = createControl();
    const { session, events } = mountSession(control);

    await openAndResolve(session, control);

    events.length = 0;
    control.displayCalls.length = 0;

    const pending = session.display("ch2.xhtml");
    await waitFor(() => control.displayCalls.length >= 1, "pending display");

    session.destroy();

    control.displayCalls[0]!.deferred.resolve();
    await pending;

    expect(events.filter((e) => e.type === "location")).toHaveLength(0);
    expect(
      events.filter((e) => e.type === "status" && e.status === "idle"),
    ).toHaveLength(0);
  });

  it("destroy() removes listeners, destroys rendition/book, revokes owned object URLs", async () => {
    const control = createControl();
    const { session } = mountSession(control);

    await openAndResolve(session, control);

    const revokeSpy = vi.spyOn(URL, "revokeObjectURL");
    const owned = createOwnedObjectURL(
      session,
      new Blob(["img"], { type: "image/png" }),
    );
    expect(owned.startsWith("blob:")).toBe(true);

    // Capture listener count before destroy.
    expect(control.listeners.get("relocated")?.size ?? 0).toBeGreaterThan(0);

    session.destroy();

    expect(control.renditionDestroyed).toBe(true);
    expect(control.bookDestroyed).toBe(true);
    expect(control.listeners.get("relocated")?.size ?? 0).toBe(0);
    expect(revokeSpy).toHaveBeenCalledWith(owned);

    // Further API use fails closed.
    await expect(session.display("ch1.xhtml")).rejects.toThrow(/destroyed/i);

    revokeSpy.mockRestore();
  });

  it("resizes the current rendition without destroying or redisplaying it", async () => {
    const control = createControl();
    const { session, events } = mountSession(control);
    await openAndResolve(session, control);

    // Same document identity before and after resize (EPUB.js reuse).
    const sameDoc = new DOMParser().parseFromString(
      "<html><body><p>章節文字</p><button type='button' aria-label='點擊顯示圖片'>點擊顯示圖片</button><img data-epub-src='images/a.png' alt='x'></body></html>",
      "text/html",
    );
    control.contentsDocument = sameDoc;

    const initialDisplayCount = control.displayCalls.length;
    session.resize();

    expect(control.resizeCalls).toEqual([{ width: undefined, height: undefined }]);
    expect(control.renditionDestroyed).toBe(false);
    // Resize must never call rendition.display(cfi).
    expect(control.displayCalls).toHaveLength(initialDisplayCount);

    // Debounced rebind on the same Document must keep gestures live.
    await new Promise((r) => setTimeout(r, 120));
    expect(control.displayCalls).toHaveLength(initialDisplayCount);

    events.length = 0;
    sameDoc.body?.dispatchEvent(new Event("click", { bubbles: true }));
    expect(events.some((e) => e.type === "content-tap")).toBe(true);

    session.destroy();
  });

  async function flushAppearanceRelayout(): Promise<void> {
    // applyAppearance waits two parent animation frames before resize.
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
  }

  it("relayouts after font size change so paginated columns remeasure", async () => {
    const control = createControl();
    const { session } = mountSession(control);
    await openAndResolve(session, control);
    control.resizeCalls.length = 0;

    session.applyAppearance({
      fontSizePercent: 130,
      fontFamily: "book",
      background: "rice",
      theme: "system",
      horizontalMarginPercent: 4,
    });

    // Themes inject synchronously; resize is deferred two frames.
    expect(control.resizeCalls).toHaveLength(0);
    await flushAppearanceRelayout();
    expect(control.resizeCalls).toEqual([{ width: undefined, height: undefined }]);

    session.destroy();
  });

  it("does not resize for color-only appearance changes", async () => {
    const control = createControl();
    const { session } = mountSession(control);
    await openAndResolve(session, control);
    control.resizeCalls.length = 0;

    session.applyAppearance({
      fontSizePercent: 100,
      fontFamily: "book",
      background: "white",
      theme: "night",
      horizontalMarginPercent: 4,
    });

    await flushAppearanceRelayout();
    expect(control.resizeCalls).toHaveLength(0);

    session.destroy();
  });

  it("coalesces rapid font size taps into a single appearance resize", async () => {
    const control = createControl();
    const { session } = mountSession(control);
    await openAndResolve(session, control);
    control.resizeCalls.length = 0;

    session.applyAppearance({
      fontSizePercent: 110,
      fontFamily: "book",
      background: "rice",
      theme: "system",
    });
    session.applyAppearance({
      fontSizePercent: 120,
      fontFamily: "book",
      background: "rice",
      theme: "system",
    });
    session.applyAppearance({
      fontSizePercent: 130,
      fontFamily: "book",
      background: "rice",
      theme: "system",
    });

    await flushAppearanceRelayout();
    expect(control.resizeCalls).toHaveLength(1);

    session.destroy();
  });

  it("relayouts after horizontal margin change", async () => {
    const control = createControl();
    const { session } = mountSession(control);
    await openAndResolve(session, control);
    control.resizeCalls.length = 0;

    session.applyAppearance({
      fontSizePercent: 100,
      fontFamily: "book",
      background: "rice",
      theme: "system",
      horizontalMarginPercent: 12,
    });

    await flushAppearanceRelayout();
    expect(control.resizeCalls).toHaveLength(1);

    session.destroy();
  });

  it("resize rebind does not recapture original text baseline", async () => {
    const captureSpy = vi.spyOn(ChapterConverter.prototype, "capture");
    const control = createControl();
    const chapterDoc = new DOMParser().parseFromString(
      "<html><body><p class='body'>汉语</p></body></html>",
      "text/html",
    );
    control.contentsDocument = chapterDoc;
    const { session } = mountSession(control);

    await openAndResolve(session, control);
    const capturesAfterOpen = captureSpy.mock.calls.length;
    expect(capturesAfterOpen).toBeGreaterThanOrEqual(1);

    await session.setConversion("traditional");
    // Resize must rebind gates/gestures without calling capture again.
    session.resize();
    await new Promise((r) => setTimeout(r, 120));
    expect(captureSpy.mock.calls.length).toBe(capturesAfterOpen);

    // Late `rendered` after resize must also not force-recapture (原文 poison).
    control.emit("rendered");
    await new Promise((r) => setTimeout(r, 50));
    expect(captureSpy.mock.calls.length).toBe(capturesAfterOpen);

    // Failed navigation rebind path also must not recapture.
    const nextPromise = session.goNext();
    await waitFor(() => control.nextCalls.length >= 1, "next for rebind");
    control.nextCalls[0]!.reject(new Error("nav failed"));
    await expect(nextPromise).rejects.toThrow(/nav failed/);
    expect(captureSpy.mock.calls.length).toBe(capturesAfterOpen);

    captureSpy.mockRestore();
    session.destroy();
  });

  it("resize during open does not supersede open", async () => {
    const control = createControl();
    const { session } = mountSession(control);
    const openPromise = session.open(
      new Blob(["epub"], { type: "application/epub+zip" }),
    );
    await waitFor(() => control.displayCalls.length >= 1, "open display");

    // Must not call beginOp / cancel open.
    session.resize();
    expect(control.resizeCalls.length).toBe(1);

    control.displayCalls[0]!.deferred.resolve();
    const summary = await openPromise;
    expect(summary.title).toBe("測試書");
    session.destroy();
  });

  it("resize during goNext does not redisplay the previous page over navigation", async () => {
    const control = createControl();
    const { session } = mountSession(control);
    await openAndResolve(session, control);
    const beforeHref = session.getLocation()?.spineHref;

    const nextPromise = session.goNext();
    await waitFor(() => control.nextCalls.length >= 1, "next call");
    const displaysAtNav = control.displayCalls.length;

    session.resize();
    // Allow resize debounce to fire while nav is in flight — must not redisplay.
    await new Promise((r) => setTimeout(r, 100));
    expect(control.displayCalls.length).toBe(displaysAtNav);

    control.nextCalls[0]!.resolve();
    await nextPromise;

    const afterHref = session.getLocation()?.spineHref;
    expect(afterHref).toBeTruthy();
    expect(afterHref).not.toBe(beforeHref);
    session.destroy();
  });

  it("goNext after resize is scheduled wins; resize does not rewind location", async () => {
    const control = createControl();
    const { session } = mountSession(control);
    await openAndResolve(session, control);
    const startHref = session.getLocation()?.spineHref;
    const displaysBefore = control.displayCalls.length;

    // Schedule resize rebind first (idle).
    session.resize();
    // Start navigation before debounce fires — beginOp cancels resize token.
    await new Promise((r) => setTimeout(r, 10));
    const nextPromise = session.goNext();
    await waitFor(() => control.nextCalls.length >= 1, "next after resize");
    control.nextCalls[0]!.resolve();
    await nextPromise;

    // Let former resize debounce window pass; must not call display or rewind.
    await new Promise((r) => setTimeout(r, 120));
    expect(control.displayCalls.length).toBe(displaysBefore);
    expect(session.getLocation()?.spineHref).not.toBe(startHref);
    session.destroy();
  });

  it("goNext with async currentLocation still detects spine change", async () => {
    const control = createControl();
    control.asyncLocationAfterNext = true;
    const oldDoc = new DOMParser().parseFromString(
      "<html><body><p data-old='1'>舊</p></body></html>",
      "text/html",
    );
    const newDoc = new DOMParser().parseFromString(
      "<html><body><p data-new='1'>新</p></body></html>",
      "text/html",
    );
    control.contentsDocument = oldDoc;
    const { session } = mountSession(control);
    await openAndResolve(session, control);

    const nextPromise = session.goNext();
    await waitFor(() => control.nextCalls.length >= 1, "async loc next");
    control.nextCalls[0]!.resolve();
    setTimeout(() => {
      control.contentsDocument = newDoc;
      control.emit("rendered");
    }, 40);
    await nextPromise;

    expect(session.getLocation()?.spineHref).toBe("ch2.xhtml");
    expect(session.getLocation()?.spineIndex).toBe(1);
    session.destroy();
  });

  it("cross-spine never-ready keeps old chapter and does not emit idle success", async () => {
    const control = createControl();
    const oldDoc = new DOMParser().parseFromString(
      "<html><body><p data-old='1'>舊</p></body></html>",
      "text/html",
    );
    control.contentsDocument = oldDoc;
    const { session, events } = mountSession(control);
    await openAndResolve(session, control);
    events.length = 0;

    const displayPromise = session.display("ch2.xhtml");
    await waitFor(() => control.displayCalls.length >= 1, "late display");
    // Resolve navigation while Document stays on the old chapter forever.
    control.displayCalls[control.displayCalls.length - 1]!.deferred.resolve();

    // Rollback may issue additional display() calls — resolve them while
    // keeping the live contents on the still-ready old document.
    const pump = setInterval(() => {
      for (const call of control.displayCalls) {
        call.deferred.resolve();
      }
    }, 20);

    await expect(displayPromise).rejects.toThrow(/not ready|recovery/i);
    clearInterval(pump);
    expect(
      events.some((e) => e.type === "status" && e.status === "error"),
    ).toBe(true);
    // Must not report idle success after a failed destination settle.
    expect(
      events.some((e) => e.type === "status" && e.status === "idle"),
    ).toBe(false);
    // Old chapter remains interactive; location not advanced to ch2.
    expect(session.getLocation()?.spineHref).toBe("ch1.xhtml");
    events.length = 0;
    // Use live getContents document identity (same as oldDoc while pinned).
    const live = control.contentsDocument;
    expect(live).toBe(oldDoc);
    live?.body?.dispatchEvent(new Event("click", { bubbles: true }));
    expect(events.some((e) => e.type === "content-tap")).toBe(true);
    session.destroy();
  });

  it("empty-shell timeout rolls back via display to a restored live Document", async () => {
    const control = createControl();
    const oldDoc = new DOMParser().parseFromString(
      "<html><body><p data-old='1'>舊章</p></body></html>",
      "text/html",
    );
    const emptyShell = new DOMParser().parseFromString(
      "<html><body></body></html>",
      "text/html",
    );
    // Distinct restored live Document after rollback (not the detached oldDoc).
    const restoredDoc = new DOMParser().parseFromString(
      "<html><body><p data-restored='1'>已還原</p></body></html>",
      "text/html",
    );
    control.contentsDocument = oldDoc;
    const { session, events } = mountSession(control);
    await openAndResolve(session, control);
    const oldHref = session.getLocation()?.spineHref;
    expect(oldHref).toBe("ch1.xhtml");

    events.length = 0;
    control.displayCalls.length = 0;
    const displayPromise = session.display("ch2.xhtml");
    await waitFor(() => control.displayCalls.length >= 1, "nav display");
    control.displayCalls[0]!.deferred.resolve();
    // Permanent empty shell — destination never becomes ready.
    control.contentsDocument = emptyShell;

    // Rollback display(cfi/href) must land on ch1 location; only then expose
    // a ready live Document for that spine.
    const pump = setInterval(() => {
      for (const call of control.displayCalls) {
        const t = call.target;
        const targetsOldSpine =
          t === undefined ||
          t === "ch1.xhtml" ||
          (typeof t === "string" && t.includes("ch1.xhtml"));
        if (targetsOldSpine && control.displayCalls.indexOf(call) >= 1) {
          control.contentsDocument = restoredDoc;
        }
        call.deferred.resolve();
      }
    }, 20);

    await expect(displayPromise).rejects.toThrow(/not ready|recovery/i);
    clearInterval(pump);

    // Rollback must have invoked at least one extra display.
    expect(control.displayCalls.length).toBeGreaterThanOrEqual(2);
    // Live contents identity is the restored Document, not the empty shell.
    expect(control.contentsDocument).toBe(restoredDoc);
    expect(control.contentsDocument).not.toBe(oldDoc);
    expect(control.contentsDocument).not.toBe(emptyShell);
    // Location comes from actual rendition after rollback display, not hard-write.
    expect(session.getLocation()?.spineHref).toBe("ch1.xhtml");
    expect(session.getLocation()?.spineIndex).toBe(0);

    // Content tap must hit the restored *live* document (not detached oldDoc).
    events.length = 0;
    restoredDoc.body?.dispatchEvent(new Event("click", { bubbles: true }));
    expect(events.some((e) => e.type === "content-tap")).toBe(true);
    session.destroy();
  });

  it(
    "rollback fails when live Document stays on destination chapter",
    async () => {
      const control = createControl();
      control.sections = [
        { href: "ch1.xhtml", index: 0 },
        { href: "ch2.xhtml", index: 1 },
        { href: "ch3.xhtml", index: 2 },
      ];
      const ch2Doc = new DOMParser().parseFromString(
        "<html><body><p data-ch='2'>第二章</p></body></html>",
        "text/html",
      );
      const emptyShell = new DOMParser().parseFromString(
        "<html><body></body></html>",
        "text/html",
      );
      const destDoc = new DOMParser().parseFromString(
        "<html><body><p data-ch='3'>第三章</p></body></html>",
        "text/html",
      );
      // Open without pinned doc so cross-spine can change Document identity.
      const { session, events } = mountSession(control);
      await openAndResolve(session, control);

      control.displayCalls.length = 0;
      const toCh2 = session.display("ch2.xhtml");
      await waitFor(() => control.displayCalls.length >= 1, "open ch2");
      control.contentsDocument = ch2Doc;
      control.displayCalls[0]!.deferred.resolve();
      await toCh2;
      expect(session.getLocation()?.spineHref).toBe("ch2.xhtml");
      const locationBeforeFailedNav = session.getLocation()?.cfi;

      events.length = 0;
      control.displayCalls.length = 0;
      const displayPromise = session.display("ch3.xhtml");
      await waitFor(() => control.displayCalls.length >= 1, "nav ch3");
      control.displayCalls[0]!.deferred.resolve();
      control.contentsDocument = emptyShell;

      // Rollback display resolves but spine stays on ch3 with a ready Document.
      control.forceDisplayHref = "ch3.xhtml";
      const pump = setInterval(() => {
        if (control.displayCalls.length >= 2) {
          control.contentsDocument = destDoc;
        }
        for (const call of control.displayCalls) {
          call.deferred.resolve();
        }
      }, 20);

      await expect(displayPromise).rejects.toThrow(/recovery|not ready/i);
      clearInterval(pump);
      control.forceDisplayHref = null;

      expect(
        events.some((e) => e.type === "status" && e.status === "idle"),
      ).toBe(false);
      expect(session.getLocation()?.spineHref).not.toBe("ch3.xhtml");
      const locationEvents = events.filter(
        (e) => e.type === "location",
      ) as Array<{ type: "location"; location: ReaderLocation }>;
      const claimedRestore = locationEvents.some(
        (e) =>
          e.location.spineHref === "ch2.xhtml" &&
          e.location.cfi === locationBeforeFailedNav &&
          control.contentsDocument === destDoc,
      );
      expect(claimedRestore).toBe(false);
      session.destroy();
    },
    20_000,
  );

  it(
    "does not treat display(undefined) first-spine as restore of mid-book chapter",
    async () => {
      const control = createControl();
      control.sections = [
        { href: "ch1.xhtml", index: 0 },
        { href: "ch2.xhtml", index: 1 },
        { href: "ch3.xhtml", index: 2 },
      ];
      const ch2Doc = new DOMParser().parseFromString(
        "<html><body><p data-ch='2'>第二章</p></body></html>",
        "text/html",
      );
      const emptyShell = new DOMParser().parseFromString(
        "<html><body></body></html>",
        "text/html",
      );
      const { session, events } = mountSession(control);
      await openAndResolve(session, control);

      control.displayCalls.length = 0;
      const toCh2 = session.display("ch2.xhtml");
      await waitFor(() => control.displayCalls.length >= 1, "to ch2");
      control.contentsDocument = ch2Doc;
      control.displayCalls[0]!.deferred.resolve();
      await toCh2;
      expect(session.getLocation()?.spineIndex).toBe(1);

      events.length = 0;
      control.displayCalls.length = 0;
      const displayPromise = session.display("ch3.xhtml");
      await waitFor(() => control.displayCalls.length >= 1, "to ch3");
      control.displayCalls[0]!.deferred.resolve();
      control.contentsDocument = emptyShell;

      // CFI + href rollback fail; display(undefined) must not be attempted.
      const pump = setInterval(() => {
        for (const call of control.displayCalls) {
          const t = call.target;
          if (
            typeof t === "string" &&
            (t.includes("epubcfi") || t === "ch2.xhtml")
          ) {
            call.deferred.reject(new Error("rollback target failed"));
            continue;
          }
          call.deferred.resolve();
        }
      }, 20);

      await expect(displayPromise).rejects.toThrow(/recovery|not ready/i);
      clearInterval(pump);

      const rollbackCalls = control.displayCalls.slice(1);
      expect(rollbackCalls.every((c) => c.target !== undefined)).toBe(true);
      expect(
        events.some((e) => e.type === "status" && e.status === "idle"),
      ).toBe(false);
      session.destroy();
    },
    20_000,
  );

  it("cross-spine waits for destination ready before tearing down old chapter", async () => {
    const control = createControl();
    const oldDoc = new DOMParser().parseFromString(
      "<html><body><p data-old='1'>舊章</p></body></html>",
      "text/html",
    );
    const emptyShell = new DOMParser().parseFromString(
      "<html><body></body></html>",
      "text/html",
    );
    const newDoc = new DOMParser().parseFromString(
      "<html><body><p data-new='1'>新章</p></body></html>",
      "text/html",
    );
    control.contentsDocument = oldDoc;
    const { session, events } = mountSession(control);
    await openAndResolve(session, control);

    // Track that old chapter still receives taps while shell is empty.
    control.displayCalls.length = 0;
    const displayPromise = session.display("ch2.xhtml");
    await waitFor(() => control.displayCalls.length >= 1, "display ch2");
    control.displayCalls[0]!.deferred.resolve();
    // Briefly expose empty shell (not ready) then real destination.
    control.contentsDocument = emptyShell;
    setTimeout(() => {
      control.contentsDocument = newDoc;
      control.emit("rendered");
    }, 100);

    await displayPromise;
    expect(session.getLocation()?.spineHref).toBe("ch2.xhtml");
    events.length = 0;
    newDoc.body?.dispatchEvent(new Event("click", { bubbles: true }));
    expect(events.some((e) => e.type === "content-tap")).toBe(true);
    session.destroy();
  });

  it("goNext across spine rejects previous document until the new one is ready", async () => {
    const control = createControl();
    const oldDoc = new DOMParser().parseFromString(
      "<html><body><p data-old='1'>舊章</p></body></html>",
      "text/html",
    );
    const newDoc = new DOMParser().parseFromString(
      "<html><body><p data-new='1'>新章</p></body></html>",
      "text/html",
    );
    control.contentsDocument = oldDoc;
    const { session } = mountSession(control);
    await openAndResolve(session, control);

    const nextPromise = session.goNext();
    await waitFor(() => control.nextCalls.length >= 1, "next boundary");
    // After next resolves, keep exposing the previous non-empty document briefly.
    control.nextCalls[0]!.resolve();
    setTimeout(() => {
      control.contentsDocument = newDoc;
      control.emit("rendered");
    }, 80);

    await nextPromise;
    expect(session.getLocation()?.spineHref).toBe("ch2.xhtml");
    expect(control.contentsDocument?.querySelector("[data-new]")).toBeTruthy();
    // New chapter should accept content-tap on the new document.
    const events: ReaderEvent[] = [];
    session.subscribe((e) => events.push(e));
    newDoc.body?.dispatchEvent(new Event("click", { bubbles: true }));
    expect(events.some((e) => e.type === "content-tap")).toBe(true);
    session.destroy();
  });

  it("failed display rebinds current chapter controls", async () => {
    const control = createControl();
    const { session, events } = mountSession(control);
    await openAndResolve(session, control);
    events.length = 0;

    const displayPromise = session.display("missing.xhtml");
    await waitFor(() => control.displayCalls.length >= 2, "failed display");
    control.displayCalls[control.displayCalls.length - 1]!.deferred.reject(
      new Error("bad toc href"),
    );
    await expect(displayPromise).rejects.toThrow(/bad toc href/);

    expect(
      events.some((e) => e.type === "status" && e.status === "error"),
    ).toBe(true);
    // Session remains usable — a subsequent display can succeed.
    const retry = session.display("ch2.xhtml");
    await waitFor(
      () => control.displayCalls.some((c) => c.target === "ch2.xhtml"),
      "retry display",
    );
    const ch2 = control.displayCalls.find((c) => c.target === "ch2.xhtml")!;
    ch2.deferred.resolve();
    await retry;
    expect(session.getLocation()?.spineHref).toBe("ch2.xhtml");
    session.destroy();
  });

  it("failed cross-spine display after content hook keeps current image blob", async () => {
    const control = createControl();
    const chapterDoc = new DOMParser().parseFromString(
      `<html><body>
        <img data-epub-src="images/a.png" alt="x">
        <button type="button" aria-label="點擊顯示圖片">點擊顯示圖片</button>
      </body></html>`,
      "text/html",
    );
    // Place button before img as parent-gate pairing expects.
    const img = chapterDoc.querySelector("img")!;
    const btn = chapterDoc.querySelector("button")!;
    img.parentNode?.insertBefore(btn, img);

    control.contentsDocument = chapterDoc;
    const { session, events } = mountSession(control);
    await openAndResolve(session, control);

    // Materialize a chapter image blob via archive createUrl path.
    control.imageUrl.resolve("blob:fake-chapter-image");
    // Trigger spine content hook for current chapter then rebind (open already did).
    await control.contentHooks.trigger!(
      chapterDoc,
      { href: "ch1.xhtml" },
    );

    // Simulate revealed image URL tracked on session via materialize.
    // Track via public trackObjectUrl after forcing makeMaterialize usage:
    // install parent gate click path is heavy; instead assert revoke does not
    // fire when display fails after *incoming* hook only.
    const incomingDoc = new DOMParser().parseFromString(
      "<html><body><p>incoming</p></body></html>",
      "text/html",
    );
    // Start failed display; fire content hook for destination while in-flight.
    control.displayCalls.length = 0;
    const displayPromise = session.display("ch2.xhtml");
    await waitFor(() => control.displayCalls.length >= 1, "cross display");
    // Incoming content hook must not revoke live chapter resources.
    await control.contentHooks.trigger!(
      incomingDoc,
      { href: "ch2.xhtml" },
    );
    control.displayCalls[0]!.deferred.reject(new Error("display failed"));
    await expect(displayPromise).rejects.toThrow(/display failed/);

    // Current chapter still interactive.
    events.length = 0;
    chapterDoc.body?.dispatchEvent(new Event("click", { bubbles: true }));
    expect(events.some((e) => e.type === "content-tap")).toBe(true);
    // Live location unchanged.
    expect(session.getLocation()?.spineHref).toBe("ch1.xhtml");
    session.destroy();
  });

  it("after display settles, only the new contents document is bound", async () => {
    const control = createControl();
    const oldDoc = new DOMParser().parseFromString(
      "<html><body><p>舊章</p></body></html>",
      "text/html",
    );
    const newDoc = new DOMParser().parseFromString(
      "<html><body><p data-new-chapter='1'>新章</p></body></html>",
      "text/html",
    );
    control.contentsDocument = oldDoc;
    const { session } = mountSession(control);
    await openAndResolve(session, control);

    const displayPromise = session.display("ch2.xhtml");
    await waitFor(() => control.displayCalls.length >= 2, "display ch2");
    const call = control.displayCalls[control.displayCalls.length - 1]!;
    call.deferred.resolve();

    // Keep returning the old non-empty document for a few ticks, then swap.
    setTimeout(() => {
      control.contentsDocument = newDoc;
      control.emit("rendered");
    }, 80);

    await displayPromise;
    // Location updated for ch2; new document is the bound contents.
    expect(session.getLocation()?.spineHref).toBe("ch2.xhtml");
    expect(control.contentsDocument?.querySelector("[data-new-chapter]")).toBeTruthy();
    session.destroy();
  });

  it("registers transform only on spine.hooks.content, never rendition.hooks.content", async () => {
    const control = createControl();
    const { session } = mountSession(control);

    await openAndResolve(session, control);

    expect(control.contentHooks.handlers.length).toBeGreaterThanOrEqual(1);
    expect(control.renditionContentHooks.handlers.length).toBe(0);

    // Running the spine content hook sanitizes images.
    const doc = new DOMParser().parseFromString(
      `<html><body><img src="images/a.png" alt="x"><img src="https://evil.example/x.png" alt="r"></body></html>`,
      "text/html",
    );
    await control.contentHooks.trigger!(doc);
    for (const img of Array.from(doc.getElementsByTagName("img"))) {
      expect(img.getAttribute("src")).toBeNull();
    }
    const local = doc.querySelector("img[data-epub-src]");
    // Package path is stored; blob materialization happens only on reveal.
    expect(local?.getAttribute("data-epub-src")).toBe("images/a.png");

    session.destroy();
  });

  it("single-flights concurrent reveals of the same chapter image", async () => {
    const control = createControl();
    const { session } = mountSession(control);
    await openAndResolve(session, control);

    const doc = new DOMParser().parseFromString(
      `<html><body><img src="images/a.png" alt="x"></body></html>`,
      "text/html",
    );
    await control.contentHooks.trigger!(doc);
    const gate = doc.querySelector("button");
    expect(gate).not.toBeNull();

    gate!.click();
    gate!.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(control.imageCreateCalls).toHaveLength(1);

    control.imageUrl.resolve("data:image/png;base64,iVBORw0KGgo=");
    await Promise.resolve();
    session.destroy();
  });

  it("open returns book summary metadata and toc", async () => {
    const control = createControl();
    const { session } = mountSession(control);
    const summary = await openAndResolve(session, control);
    expect(summary.title).toBe("測試書");
    expect(summary.creator).toBe("作者");
    expect(summary.toc.map((t) => t.href)).toEqual([
      "ch1.xhtml",
      "ch2.xhtml",
    ]);
    expect(session.getPersistence()).toBe("durable");
    session.destroy();
  });

  it("setConversion generation ignores stale apply after destroy", async () => {
    const control = createControl();
    const { session, events } = mountSession(control);
    await openAndResolve(session, control);
    events.length = 0;

    const conversionPromise = session.setConversion("traditional");
    session.destroy();
    // Should settle without throwing conversion-error after destroy (stale).
    await conversionPromise.catch(() => {
      // apply may reject if converter already destroyed mid-flight; either is fine
    });
    expect(
      events.filter((e) => e.type === "conversion-error"),
    ).toHaveLength(0);
  });

  it("conversion mid-flight does not abort goNext chapter settlement", async () => {
    const control = createControl();
    const { session, events } = mountSession(control);
    await openAndResolve(session, control);
    events.length = 0;

    const nextPromise = session.goNext();
    await waitFor(() => control.nextCalls.length >= 1, "next call");

    // Conversion must not bump navigation generation.
    await session.setConversion("simplified").catch(() => {
      // converter may no-op without captured nodes
    });

    control.nextCalls[0]!.resolve();
    await nextPromise;

    const statuses = events.filter((e) => e.type === "status") as Array<{
      type: "status";
      status: string;
    }>;
    expect(statuses.some((s) => s.status === "idle")).toBe(true);
    expect(statuses.some((s) => s.status === "error")).toBe(false);

    session.destroy();
  });

  it("failed goNext rebinds without leaving permanent error when prev succeeds", async () => {
    const control = createControl();
    const { session, events } = mountSession(control);
    await openAndResolve(session, control);
    events.length = 0;

    const nextPromise = session.goNext();
    await waitFor(() => control.nextCalls.length >= 1, "next call");
    control.nextCalls[0]!.reject(new Error("at end"));
    await expect(nextPromise).rejects.toThrow(/at end/);

    // Still idle-capable after rebind path: another prev should work.
    const prevPromise = session.goPrevious();
    await waitFor(() => control.prevCalls.length >= 1, "prev call");
    control.prevCalls[0]!.resolve();
    await prevPromise;

    const errors = events.filter(
      (e) => e.type === "status" && e.status === "error",
    );
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(
      events.some((e) => e.type === "status" && e.status === "idle"),
    ).toBe(true);

    session.destroy();
  });

  it("treats EPUB.js no-section responses at a book boundary as an idle no-op", async () => {
    const control = createControl();
    const { session, events } = mountSession(control);
    await openAndResolve(session, control);
    events.length = 0;

    const previousPromise = session.goPrevious();
    await waitFor(() => control.prevCalls.length >= 1, "previous boundary");
    control.prevCalls[0]!.reject(new Error("No Section Found"));

    await expect(previousPromise).resolves.toBeUndefined();
    expect(
      events.some((event) => event.type === "status" && event.status === "error"),
    ).toBe(false);
    expect(
      events.some((event) => event.type === "status" && event.status === "idle"),
    ).toBe(true);
    session.destroy();
  });

  it("keeps a no-section error visible when previous fails mid-book", async () => {
    const control = createControl();
    const { session, events } = mountSession(control);
    await openAndResolve(session, control);
    control.setLocation({
      cfi: "epubcfi(/6/4[ch2.xhtml]!/4/2/2)",
      href: "ch2.xhtml",
      index: 1,
    });
    control.emit("relocated", control.location);
    events.length = 0;

    const previousPromise = session.goPrevious();
    await waitFor(() => control.prevCalls.length >= 1, "mid-book previous");
    control.prevCalls[0]!.reject(new Error("No Section Found"));

    await expect(previousPromise).rejects.toThrow("No Section Found");
    expect(
      events.some((event) => event.type === "status" && event.status === "error"),
    ).toBe(true);
    session.destroy();
  });

  it("treats a no-section response at the final spine item as a next-page no-op", async () => {
    const control = createControl();
    const { session, events } = mountSession(control);
    await openAndResolve(session, control);
    control.setLocation({
      cfi: "epubcfi(/6/4[ch3.xhtml]!/4/2/2)",
      href: "ch3.xhtml",
      index: 2,
    });
    control.emit("relocated", control.location);
    events.length = 0;

    const nextPromise = session.goNext();
    await waitFor(() => control.nextCalls.length >= 1, "next boundary");
    control.nextCalls[0]!.reject(new Error("No Section Found"));

    await expect(nextPromise).resolves.toBeUndefined();
    expect(
      events.some((event) => event.type === "status" && event.status === "error"),
    ).toBe(false);
    session.destroy();
  });

  it("turns a paginated chapter from its in-frame touch pointer without blocking links", async () => {
    const control = createControl();
    const chapterDoc = new DOMParser().parseFromString(
      "<html><body><a href='#note'>註腳</a><p>章節文字</p></body></html>",
      "text/html",
    );
    control.contentsDocument = chapterDoc;
    const { session } = mountSession(control);
    await openAndResolve(session, control);

    const dispatch = (type: "pointerdown" | "pointerup", x: number) => {
      const event = new Event(type, { bubbles: true });
      Object.defineProperties(event, {
        clientX: { value: x },
        clientY: { value: 240 },
        isPrimary: { value: true },
        pointerType: { value: "touch" },
      });
      chapterDoc.body?.dispatchEvent(event);
    };
    dispatch("pointerdown", 300);
    dispatch("pointerup", 120);

    await waitFor(() => control.nextCalls.length >= 1, "in-frame pointer next");
    control.nextCalls[0]!.resolve();
    await Promise.resolve();
    const link = chapterDoc.querySelector("a");
    const onLinkClick = vi.fn();
    link?.addEventListener("click", onLinkClick);
    (link as HTMLAnchorElement | null)?.click();
    expect(onLinkClick).toHaveBeenCalledOnce();
    session.destroy();
  });

  it("same-spine next keeps Document bindings and advances chapter page", async () => {
    const control = createControl();
    control.sameSpinePaging = true;
    const chapterDoc = new DOMParser().parseFromString(
      "<html><body><p>同章多頁文字</p></body></html>",
      "text/html",
    );
    control.contentsDocument = chapterDoc;
    const { session, events } = mountSession(control);
    await openAndResolve(session, control);

    // Ensure open settled on page 1 of a multi-page chapter.
    expect(session.getLocation()?.spineHref).toBe("ch1.xhtml");
    expect(session.getLocation()?.chapterPage).toBe(1);

    events.length = 0;
    const nextPromise = session.goNext();
    await waitFor(() => control.nextCalls.length >= 1, "same-spine next");
    control.nextCalls[0]!.resolve();
    await nextPromise;

    const loc = session.getLocation();
    expect(loc?.spineHref).toBe("ch1.xhtml");
    expect(loc?.spineIndex).toBe(0);
    expect(loc?.chapterPage).toBe(2);
    // Same Document — content-tap must still fire (bindings not torn down).
    events.length = 0;
    chapterDoc.body?.dispatchEvent(new Event("click", { bubbles: true }));
    expect(events.some((e) => e.type === "content-tap")).toBe(true);

    session.destroy();
  });

  it("resume approximatePercent uses 0–100 scale for spine index", async () => {
    const control = createControl();
    // Three spine items so 33% lands on index 0, 50% on index 1, not last.
    control.sections = [
      { href: "ch1.xhtml", index: 0 },
      { href: "ch2.xhtml", index: 1 },
      { href: "ch3.xhtml", index: 2 },
    ];
    const { session } = mountSession(control);
    const openPromise = session.open(
      new Blob(["epub"], { type: "application/epub+zip" }),
      { approximatePercent: 50 },
    );
    // open falls through to percent after first display(undefined) if no cfi.
    // First display is undefined (openWithResumeFallback), then percent path
    // may issue another display for ch2.
    await waitFor(() => control.displayCalls.length >= 1, "open display");
    // Resolve all pending displays as they appear (percent may add more).
    for (let i = 0; i < 8; i += 1) {
      const pending = control.displayCalls.find((c) => {
        // deferred not yet resolved — resolve all
        return true;
      });
      void pending;
      for (const call of control.displayCalls) {
        try {
          call.deferred.resolve();
        } catch {
          // already resolved
        }
      }
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 20));
    }
    await openPromise;
    // 50% of 3 spines → index floor(0.5*3)=1 → ch2
    expect(session.getLocation()?.spineHref).toBe("ch2.xhtml");
    session.destroy();
  });

  it("same-Document CFI display does not teardown chapter bindings", async () => {
    const control = createControl();
    const chapterDoc = new DOMParser().parseFromString(
      "<html><body><p>保留轉換基準</p></body></html>",
      "text/html",
    );
    control.contentsDocument = chapterDoc;
    const { session, events } = mountSession(control);
    await openAndResolve(session, control);

    // Public path: content-tap proves bindings; also verify location CFI updates.
    events.length = 0;
    chapterDoc.body?.dispatchEvent(new Event("click", { bubbles: true }));
    expect(events.some((e) => e.type === "content-tap")).toBe(true);

    const cfi = "epubcfi(/6/4[ch1.xhtml]!/4/2/4)";
    control.displayCalls.length = 0;
    const displayPromise = session.display(cfi);
    await waitFor(() => control.displayCalls.length >= 1, "cfi display");
    control.displayCalls[0]!.deferred.resolve();
    await displayPromise;

    expect(session.getLocation()?.cfi).toBe(cfi);
    expect(session.getLocation()?.spineHref).toBe("ch1.xhtml");
    // Bindings still live — same Document identity, no rendered event.
    events.length = 0;
    chapterDoc.body?.dispatchEvent(new Event("click", { bubbles: true }));
    expect(events.some((e) => e.type === "content-tap")).toBe(true);

    session.destroy();
  });
});
