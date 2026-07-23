/**
 * Spine-based approximate progress with debounced CFI persistence.
 *
 * Relocation events are written with a 300 ms trailing debounce.
 * pagehide and visibilitychange (hidden) flush immediately.
 */

import type { StoredProgress } from "../domain/types";
import type { ReaderLocation } from "./reader-session";

export const PROGRESS_DEBOUNCE_MS = 300;

export interface ProgressTrackerOptions {
  bookId: string;
  save: (progress: StoredProgress) => Promise<void>;
  debounceMs?: number;
  now?: () => number;
}

export interface ProgressTracker {
  /** Schedule a debounced persist for the latest location. */
  onRelocated(location: ReaderLocation): void;
  /** Persist the latest pending progress immediately (best-effort). */
  flush(): Promise<void>;
  /**
   * Listen for pagehide / visibilitychange and flush on hide.
   * Returns an unsubscribe function.
   */
  attachLifecycle(target?: Window & typeof globalThis): () => void;
  destroy(): void;
  getPending(): StoredProgress | null;
}

/**
 * Approximate reading progress from spine position and in-chapter page.
 *
 * (completed spine items + current page / chapter pages) / total spine items
 */
export function approximateProgressPercent(
  spineIndex: number,
  spineCount: number,
  chapterPage: number,
  chapterPages: number,
): number {
  const count = Math.max(1, spineCount);
  const pages = Math.max(1, chapterPages);
  const pageFraction = Math.min(1, Math.max(0, chapterPage / pages));
  const raw = ((spineIndex + pageFraction) / count) * 100;
  return Math.max(0, Math.min(100, Math.round(raw * 10) / 10));
}

export function createProgressTracker(
  options: ProgressTrackerOptions,
): ProgressTracker {
  return new ProgressTrackerImpl(options);
}

class ProgressTrackerImpl implements ProgressTracker {
  private readonly bookId: string;
  private readonly saveFn: (progress: StoredProgress) => Promise<void>;
  private readonly debounceMs: number;
  private readonly now: () => number;

  private pending: StoredProgress | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;
  private flushPromise: Promise<void> | null = null;
  private detachLifecycle: (() => void) | null = null;

  constructor(options: ProgressTrackerOptions) {
    this.bookId = options.bookId;
    this.saveFn = options.save;
    this.debounceMs = options.debounceMs ?? PROGRESS_DEBOUNCE_MS;
    this.now = options.now ?? (() => Date.now());
  }

  onRelocated(location: ReaderLocation): void {
    if (this.destroyed) return;

    const percent = Number.isFinite(location.approximatePercent)
      ? Math.max(0, Math.min(100, location.approximatePercent))
      : approximateProgressPercent(
          location.spineIndex,
          location.spineCount,
          location.chapterPage,
          location.chapterPages,
        );

    const progress: StoredProgress = {
      bookId: this.bookId,
      approximatePercent: percent,
      updatedAt: this.now(),
    };
    if (location.cfi) {
      progress.cfi = location.cfi;
    }
    if (location.spineHref) {
      progress.spineHref = location.spineHref;
    }

    this.pending = progress;
    this.schedule();
  }

  async flush(): Promise<void> {
    if (this.destroyed) return;
    this.clearTimer();

    // Wait for any in-flight write, then drain whatever is still pending
    // (including snapshots written while that write was running).
    if (this.flushPromise) {
      await this.flushPromise;
      if (this.destroyed) return;
    }

    // Drain newer snapshots written during an in-flight save, but never spin
    // forever when saveFn keeps rejecting (would block reader close).
    while (!this.destroyed && this.pending) {
      const snapshot = this.pending;
      this.pending = null;
      try {
        this.flushPromise = this.saveFn(snapshot).finally(() => {
          this.flushPromise = null;
        });
        await this.flushPromise;
      } catch (error) {
        // Restore for a later lifecycle/pagehide retry, then exit this flush.
        if (!this.destroyed && !this.pending) {
          this.pending = snapshot;
        }
        throw error instanceof Error
          ? error
          : new Error("Failed to save reading progress");
      }
      // If save succeeded and nothing newer arrived, loop ends.
    }
  }

  attachLifecycle(target: Window & typeof globalThis = window): () => void {
    if (this.destroyed) {
      return () => {
        // no-op
      };
    }

    // Replace any previous attachment.
    this.detachLifecycle?.();

    const onPageHide = (): void => {
      void this.flush();
    };
    const onVisibility = (): void => {
      if (document.visibilityState === "hidden") {
        void this.flush();
      }
    };

    target.addEventListener("pagehide", onPageHide);
    document.addEventListener("visibilitychange", onVisibility);

    const detach = (): void => {
      target.removeEventListener("pagehide", onPageHide);
      document.removeEventListener("visibilitychange", onVisibility);
      if (this.detachLifecycle === detach) {
        this.detachLifecycle = null;
      }
    };
    this.detachLifecycle = detach;
    return detach;
  }

  getPending(): StoredProgress | null {
    return this.pending;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.clearTimer();
    this.detachLifecycle?.();
    this.detachLifecycle = null;
    this.pending = null;
  }

  private schedule(): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.debounceMs);
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
