import { afterEach, describe, expect, it, vi } from "vitest";
import { ChapterConverter } from "../../src/reader/chapter-converter";
import {
  createOwnedObjectURL,
  createReaderSession,
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
  /**
   * When true, `next()` clears sync location and only exposes the new location
   * via async currentLocation() — covers Promise path for spine detection.
   */
  asyncLocationAfterNext: boolean;
  asyncLocationDeferred: Deferred<AdaptedLocation | undefined> | null;
  emit(event: string, payload?: unknown): void;
  setLocation(partial: Partial<AdaptedLocation["start"]> & { cfi: string }): void;
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
          const cur = control.location?.start.index ?? 0;
          const nextIdx = Math.min(cur + 1, control.sections.length - 1);
          const section = control.sections[nextIdx]!;
          const href = section.href ?? `ch${nextIdx + 1}.xhtml`;
          const cfi = `epubcfi(/6/4[${href}]!/4/2/2)`;
          const nextLoc: AdaptedLocation = {
            start: {
              index: nextIdx,
              href,
              cfi,
              displayed: { page: 1, total: 4 },
            },
            end: {
              index: nextIdx,
              href,
              cfi,
              displayed: { page: 1, total: 4 },
            },
          };
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
          const cur = control.location?.start.index ?? 0;
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
        return {
          document: new DOMParser().parseFromString(
            "<html><body><p>章節文字</p></body></html>",
            "text/html",
          ),
        };
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
    asyncLocationAfterNext: false,
    asyncLocationDeferred: null,
    emit(event, payload) {
      const set = control.listeners.get(event);
      if (!set) return;
      for (const listener of set) {
        listener(payload);
      }
    },
    setLocation(partial) {
      control.location = {
        start: {
          index: partial.index ?? 0,
          href: partial.href ?? "ch1.xhtml",
          cfi: partial.cfi,
          displayed: partial.displayed ?? { page: 1, total: 4 },
          percentage: partial.percentage,
        },
        end: {
          index: partial.index ?? 0,
          href: partial.href ?? "ch1.xhtml",
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

  it("when display A then B and A resolves last, only B emits location/status", async () => {
    const control = createControl();
    const { session, events } = mountSession(control);

    await openAndResolve(session, control);

    events.length = 0;
    control.displayCalls.length = 0;

    const pA = session.display("ch1.xhtml");
    await waitFor(() => control.displayCalls.length >= 1, "display A");
    const pB = session.display("ch2.xhtml");
    await waitFor(() => control.displayCalls.length >= 2, "display B");

    const callA = control.displayCalls[0]!;
    const callB = control.displayCalls[1]!;
    expect(callA.target).toBe("ch1.xhtml");
    expect(callB.target).toBe("ch2.xhtml");

    // Resolve B first, then A (stale).
    callB.deferred.resolve();
    await pB;

    callA.deferred.resolve();
    await pA;

    const locations = events.filter((e) => e.type === "location") as Array<{
      type: "location";
      location: ReaderLocation;
    }>;
    const statuses = events.filter((e) => e.type === "status") as Array<{
      type: "status";
      status: string;
    }>;

    // Only chapter B location should be published after the race.
    expect(locations.length).toBeGreaterThanOrEqual(1);
    expect(locations.every((e) => e.location.spineHref === "ch2.xhtml")).toBe(
      true,
    );

    // Final idle corresponds to B; A must not emit a trailing idle/error after B.
    const idleEvents = statuses.filter((s) => s.status === "idle");
    expect(idleEvents.length).toBe(1);

    // No location for ch1 after B started.
    expect(locations.some((e) => e.location.spineHref === "ch1.xhtml")).toBe(
      false,
    );

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

  it("late rendered after settle timeout still binds chapter controls", async () => {
    const control = createControl();
    const oldDoc = new DOMParser().parseFromString(
      "<html><body><p data-old='1'>舊</p></body></html>",
      "text/html",
    );
    const newDoc = new DOMParser().parseFromString(
      "<html><body><p data-new='1'>新章</p></body></html>",
      "text/html",
    );
    // Bind first chapter on a stable document so lastBoundDocument === oldDoc.
    control.contentsDocument = oldDoc;
    const { session, events } = mountSession(control);
    await openAndResolve(session, control);

    const displayPromise = session.display("ch2.xhtml");
    await waitFor(() => control.displayCalls.length >= 2, "late display");
    control.displayCalls[control.displayCalls.length - 1]!.deferred.resolve();

    // Keep returning the rejected old document past the ~1.2s settle window.
    await displayPromise;

    // Now the real document appears after timeout — rendered must late-rebind.
    control.contentsDocument = newDoc;
    control.emit("rendered");
    await new Promise((r) => setTimeout(r, 100));

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
});
