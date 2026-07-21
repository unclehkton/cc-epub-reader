import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StoredProgress } from "../../src/domain/types";
import type { ReaderLocation } from "../../src/reader/reader-session";
import {
  approximateProgressPercent,
  createProgressTracker,
} from "../../src/reader/progress-tracker";

function location(
  overrides: Partial<ReaderLocation> & Pick<ReaderLocation, "cfi">,
): ReaderLocation {
  return {
    spineHref: "ch1.xhtml",
    spineIndex: 0,
    spineCount: 4,
    chapterPage: 1,
    chapterPages: 1,
    approximatePercent: 0,
    ...overrides,
  };
}

describe("approximateProgressPercent", () => {
  it("returns 0 at the start of the first spine item", () => {
    expect(approximateProgressPercent(0, 4, 0, 10)).toBe(0);
    expect(approximateProgressPercent(0, 4, 1, 10)).toBe(2.5);
  });

  it("accounts for completed spine items plus in-chapter page fraction", () => {
    // spine 1 of 4 (0-based index 1), page 5 of 10 → (1 + 0.5) / 4 * 100 = 37.5
    expect(approximateProgressPercent(1, 4, 5, 10)).toBe(37.5);
  });

  it("reaches 100 at the last page of the last spine item", () => {
    expect(approximateProgressPercent(3, 4, 10, 10)).toBe(100);
  });

  it("clamps out-of-range inputs", () => {
    expect(approximateProgressPercent(-1, 4, 1, 1)).toBe(0);
    expect(approximateProgressPercent(10, 4, 1, 1)).toBe(100);
  });
});

describe("ProgressTracker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("drains pending progress written during an in-flight save", async () => {
    const saves: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let saveCount = 0;

    const save = vi.fn(async (progress: StoredProgress) => {
      saveCount += 1;
      saves.push(progress.cfi ?? "");
      if (saveCount === 1) {
        await firstGate;
      }
    });

    const tracker = createProgressTracker({
      bookId: "book-1",
      save,
    });

    tracker.onRelocated(location({ cfi: "cfi-stale", approximatePercent: 10 }));
    const firstFlush = tracker.flush();

    // While first save is in flight, a newer position arrives.
    tracker.onRelocated(location({ cfi: "cfi-fresh", approximatePercent: 55 }));
    releaseFirst();
    await firstFlush;

    // A pagehide-style second flush must persist the fresher snapshot.
    await tracker.flush();

    expect(saves).toContain("cfi-stale");
    expect(saves).toContain("cfi-fresh");
    expect(saves[saves.length - 1]).toBe("cfi-fresh");
    tracker.destroy();
  });

  it("debounces persistence with a 300 ms trailing window", async () => {
    const saves: StoredProgress[] = [];
    const save = vi.fn(async (progress: StoredProgress) => {
      saves.push(progress);
    });

    const tracker = createProgressTracker({
      bookId: "book-1",
      save,
    });

    tracker.onRelocated(
      location({
        cfi: "cfi-a",
        spineHref: "a.xhtml",
        spineIndex: 0,
        spineCount: 2,
        chapterPage: 1,
        chapterPages: 2,
        approximatePercent: approximateProgressPercent(0, 2, 1, 2),
      }),
    );
    tracker.onRelocated(
      location({
        cfi: "cfi-b",
        spineHref: "b.xhtml",
        spineIndex: 1,
        spineCount: 2,
        chapterPage: 1,
        chapterPages: 1,
        approximatePercent: approximateProgressPercent(1, 2, 1, 1),
      }),
    );

    expect(save).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(299);
    expect(save).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(save).toHaveBeenCalledTimes(1);
    expect(saves[0]).toMatchObject({
      bookId: "book-1",
      cfi: "cfi-b",
      spineHref: "b.xhtml",
    });
    expect(saves[0]!.approximatePercent).toBe(
      approximateProgressPercent(1, 2, 1, 1),
    );

    tracker.destroy();
  });

  it("flushes immediately on pagehide", async () => {
    const save = vi.fn(async (_progress: StoredProgress) => {});
    const tracker = createProgressTracker({
      bookId: "book-2",
      save,
    });
    const detach = tracker.attachLifecycle(window);

    tracker.onRelocated(
      location({
        cfi: "cfi-pagehide",
        approximatePercent: 12,
      }),
    );

    expect(save).not.toHaveBeenCalled();
    window.dispatchEvent(new Event("pagehide"));
    // flush is async; microtask + promise resolution
    await Promise.resolve();
    await Promise.resolve();

    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]![0]).toMatchObject({
      bookId: "book-2",
      cfi: "cfi-pagehide",
      approximatePercent: 12,
    });

    detach();
    tracker.destroy();
  });

  it("flushes immediately when the document becomes hidden", async () => {
    const save = vi.fn(async (_progress: StoredProgress) => {});
    const tracker = createProgressTracker({
      bookId: "book-3",
      save,
    });
    const detach = tracker.attachLifecycle(window);

    tracker.onRelocated(
      location({
        cfi: "cfi-hidden",
        approximatePercent: 55,
      }),
    );

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
    await Promise.resolve();
    await Promise.resolve();

    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]![0]).toMatchObject({
      cfi: "cfi-hidden",
      approximatePercent: 55,
    });

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });

    detach();
    tracker.destroy();
  });

  it("uses location approximatePercent when provided and recomputes when absent", async () => {
    const save = vi.fn(async (_progress: StoredProgress) => {});
    const tracker = createProgressTracker({
      bookId: "book-4",
      save,
    });

    tracker.onRelocated(
      location({
        cfi: "cfi-recompute",
        spineIndex: 1,
        spineCount: 4,
        chapterPage: 5,
        chapterPages: 10,
        approximatePercent: Number.NaN,
      }),
    );

    await vi.advanceTimersByTimeAsync(300);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]![0]!.approximatePercent).toBe(37.5);

    tracker.destroy();
  });

  it("does not schedule work after destroy", async () => {
    const save = vi.fn(async (_progress: StoredProgress) => {});
    const tracker = createProgressTracker({
      bookId: "book-5",
      save,
    });

    tracker.onRelocated(location({ cfi: "cfi-x", approximatePercent: 1 }));
    tracker.destroy();
    await vi.advanceTimersByTimeAsync(500);
    expect(save).not.toHaveBeenCalled();
  });
});
