import { afterEach, describe, expect, it, vi } from "vitest";
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
  bookDestroyed: boolean;
  renditionDestroyed: boolean;
  contentHooks: ReturnType<typeof createHook>;
  renditionContentHooks: ReturnType<typeof createHook>;
  listeners: Map<string, Set<(...args: unknown[]) => void>>;
  location: AdaptedLocation | null;
  sections: AdaptedSection[];
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
        return d.promise;
      },
      prev() {
        const d = deferred<void>();
        control.prevCalls.push(d);
        return d.promise;
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
        return {
          document: new DOMParser().parseFromString(
            "<html><body><p>章節文字</p></body></html>",
            "text/html",
          ),
        };
      },
      currentLocation() {
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
    expect(local?.getAttribute("data-epub-src")).toBe(
      "blob:fake-archive/images/a.png",
    );

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
});
