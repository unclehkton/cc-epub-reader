/**
 * EPUB.js ReaderSession — single-flight lifecycle owner.
 *
 * One session owns one Book, one Rendition, one visible spine item, and one
 * chapter-local ChapterConverter. All open/display/nav/flow/conversion/resize
 * work shares a monotonic generation; async completions for older generations
 * are ignored. destroy() invalidates work, tears down listeners/maps, and
 * revokes application-owned object URLs.
 *
 * Security: transformChapter is registered ONLY on book.spine.hooks.content
 * (pre-serialization). Never via rendition.hooks.content.
 */

import type { ConversionMode } from "../domain/types";
import { ChapterConverter } from "./chapter-converter";
import {
  injectPackageStylesheets,
  rebindImageGates,
  transformChapter,
  type ChapterTransformResult,
} from "./chapter-transformer";
import {
  createArchiveResolver,
  DEFAULT_RENDITION_OPTIONS,
  loadEpubFactory,
  enforceNoArchiveReplacements,
  disposeMaterializedUrl,
  installNoArchiveReplacementsGuard,
  materializeArchiveUrl,
  purgeArchiveUrlCache,
  type AdaptedBook,
  type AdaptedLocation,
  type AdaptedNavItem,
  type AdaptedRendition,
  type EpubFactory,
  type RenditionCreateOptions,
} from "./epub-adapter";
import {
  classifyTransition,
  locationMeaningfullyChanged,
  type TransitionSnapshot,
} from "./location-transition";
import { classifySwipe } from "./swipe";

export interface ResumeTarget {
  cfi?: string;
  spineHref?: string;
  approximatePercent?: number;
}

export interface ReaderLocation {
  cfi: string;
  spineHref: string;
  spineIndex: number;
  spineCount: number;
  chapterPage: number;
  chapterPages: number;
  approximatePercent: number;
}

export interface BookSummary {
  title: string;
  creator?: string;
  toc: Array<{ label: string; href: string }>;
}

export interface AppearanceSettings {
  fontSizePercent: number;
  fontFamily: "book" | "sans" | "system";
  background: "rice" | "white" | "sepia";
  theme: "system" | "day" | "night";
  /** Horizontal margin percent of stage width (0–20). */
  horizontalMarginPercent?: number;
}

export type ReaderEvent =
  | { type: "location"; location: ReaderLocation }
  | { type: "status"; status: "idle" | "loading" | "error"; message?: string }
  | { type: "conversion-error"; message: string }
  /** Tap on chapter content (iframe) — chrome toggle, not a link/button. */
  | { type: "content-tap" };

export interface ReaderSession {
  open(
    source: Blob | ArrayBuffer,
    resume?: string | ResumeTarget,
  ): Promise<BookSummary>;
  display(target?: string): Promise<void>;
  goPrevious(): Promise<void>;
  goNext(): Promise<void>;
  resize(): void;
  setFlow(flow: "paginated" | "scrolled"): Promise<void>;
  setConversion(mode: ConversionMode): Promise<void>;
  applyAppearance(settings: AppearanceSettings): void;
  getLocation(): ReaderLocation | null;
  getPersistence(): "durable" | "session-only";
  subscribe(listener: (event: ReaderEvent) => void): () => void;
  destroy(): void;
}

export interface ReaderSessionOptions {
  /** Host element for EPUB.js rendition. */
  element: HTMLElement;
  /** Injected book factory (tests). Defaults to lazy epubjs load. */
  createBook?: EpubFactory;
  /** When createBook is omitted, factory provider used once on first open. */
  loadFactory?: () => Promise<EpubFactory>;
  persistence?: "durable" | "session-only";
  conversion?: ConversionMode;
  flow?: "paginated" | "scrolled";
  appearance?: AppearanceSettings;
}

const FONT_STACKS: Record<AppearanceSettings["fontFamily"], string> = {
  book: `"Noto Serif TC", "Source Han Serif TC", "Songti TC", serif`,
  sans: `"Noto Sans TC", "Source Han Sans TC", "PingFang HK", sans-serif`,
  system: `system-ui, -apple-system, "Segoe UI", sans-serif`,
};

const BACKGROUNDS: Record<AppearanceSettings["background"], string> = {
  rice: "#f7f5ed",
  white: "#ffffff",
  sepia: "#f4ecd8",
};

const THEME_COLORS: Record<
  "day" | "night",
  { color: string; background: string }
> = {
  day: { color: "#18342d", background: "#f7f5ed" },
  night: { color: "#d8e0dc", background: "#0f1a17" },
};

export function createReaderSession(
  options: ReaderSessionOptions,
): ReaderSession {
  return new ReaderSessionImpl(options);
}

/**
 * Cross-realm safe Element check. Parent-realm `instanceof Element` is false
 * for nodes that live in an iframe document (different global).
 */
function eventTargetElement(target: EventTarget | null): Element | null {
  if (!target || typeof target !== "object") return null;
  const node = target as Node;
  if (node.nodeType !== 1) return null;
  const el = target as Element;
  if (typeof el.closest !== "function" || typeof el.getAttribute !== "function") {
    return null;
  }
  return el;
}

function closestElement(from: Element, selector: string): Element | null {
  try {
    return from.closest(selector);
  } catch {
    return null;
  }
}

class ReaderSessionImpl implements ReaderSession {
  private readonly element: HTMLElement;
  private readonly injectedFactory: EpubFactory | undefined;
  private readonly loadFactory: () => Promise<EpubFactory>;
  private readonly persistence: "durable" | "session-only";

  private factory: EpubFactory | null = null;
  private book: AdaptedBook | null = null;
  private rendition: AdaptedRendition | null = null;
  private generation = 0;
  /** Separate from navigation generation so OpenCC never aborts page turns. */
  private conversionGeneration = 0;
  /** Debounce token for geometry rebind — never shares nav generation. */
  private resizeToken = 0;
  private resizeTimer: ReturnType<typeof setTimeout> | null = null;
  /** Bumps on EPUB.js `rendered`; used to reject stale chapter documents. */
  private renderEpoch = 0;
  private pendingRenderWaiters: Array<() => void> = [];
  /**
   * When afterChapterSettled times out before a ready document appears, arm
   * a one-shot rebind for a later `rendered` event (same generation only).
   */
  private pendingLateChapterRebindGen: number | null = null;
  /** Last document that received live bindings (gates/links/gestures). */
  private lastBoundDocument: Document | null = null;
  private chapterGestureDisposer: (() => void) | null = null;
  private destroyed = false;
  private location: ReaderLocation | null = null;
  private conversion: ConversionMode;
  private flow: "paginated" | "scrolled";
  private appearance: AppearanceSettings;
  private readonly listeners = new Set<(event: ReaderEvent) => void>();
  private readonly ownedObjectUrls = new Set<string>();
  /** Blob URLs created for the active chapter's revealed images only. */
  private readonly chapterObjectUrls = new Set<string>();
  /** One EPUB extraction per package path while the active chapter is visible. */
  private readonly chapterMaterializations = new Map<
    string,
    Promise<string | null>
  >();
  private chapterMaterializationGeneration = 0;
  /**
   * Parent-document gate overlays paired with in-iframe images.
   * Kept as one array so reveal cannot desync button indices from image pairs.
   */
  private parentGatePairs: Array<{
    img: HTMLImageElement;
    inFrameButton: HTMLElement;
    button: HTMLButtonElement;
  }> = [];
  /** Parent overlays for external links (WebKit iframe listeners are unreliable). */
  private parentExternalLinks: Array<{
    anchor: Element;
    button: HTMLButtonElement;
    href: string;
  }> = [];
  private parentOverlayRepositionTimer: ReturnType<typeof setInterval> | null =
    null;
  private externalLinkDisposer: (() => void) | null = null;
  private readonly converter = new ChapterConverter();
  private transformResult: ChapterTransformResult | null = null;
  private spineContentHook: ((...args: unknown[]) => unknown) | null = null;
  private relocatedHandler: ((loc: unknown) => void) | null = null;
  private renderedHandler: ((section: unknown) => void) | null = null;
  private resumeCfi: string | undefined;
  private spineCount = 0;
  /** Async open/display/nav/flow ops in flight; suppresses mid-flight relocated noise. */
  private inflightOps = 0;

  constructor(options: ReaderSessionOptions) {
    this.element = options.element;
    this.injectedFactory = options.createBook;
    this.loadFactory = options.loadFactory ?? loadEpubFactory;
    this.persistence = options.persistence ?? "durable";
    this.conversion = options.conversion ?? "original";
    this.flow = options.flow ?? "paginated";
    this.appearance = options.appearance ?? {
      fontSizePercent: 100,
      fontFamily: "book",
      background: "rice",
      theme: "system",
    };
  }

  subscribe(listener: (event: ReaderEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getLocation(): ReaderLocation | null {
    return this.location;
  }

  getPersistence(): "durable" | "session-only" {
    return this.persistence;
  }

  async open(
    source: Blob | ArrayBuffer,
    resume?: string | ResumeTarget,
  ): Promise<BookSummary> {
    this.assertAlive();
    const gen = this.beginOp();
    this.emit({ type: "status", status: "loading" });
    const resumeTarget = normalizeResume(resume);
    this.resumeCfi = resumeTarget.cfi;

    try {
      await this.teardownBook();
      if (!this.isCurrent(gen)) {
        throw staleError();
      }

      const buffer =
        source instanceof ArrayBuffer
          ? source
          : await source.arrayBuffer();
      if (!this.isCurrent(gen)) {
        throw staleError();
      }

      const factory = await this.ensureFactory();
      if (!this.isCurrent(gen)) {
        throw staleError();
      }

      const book = factory(buffer, { replacements: "none" });
      this.book = book;
      // MUST run before book.ready — packaging calls Book.replacements() for
      // every archived book and would otherwise blobify all CSS/assets.
      installNoArchiveReplacementsGuard(book);
      this.registerSpineTransform(book);

      await book.ready;
      if (!this.isCurrent(gen)) {
        throw staleError();
      }
      // Re-assert guard + revoke anything that raced the pre-ready patch.
      enforceNoArchiveReplacements(book);

      this.spineCount = readSpineCount(book);
      this.rendition = this.createRendition(book);
      this.wireRendition(this.rendition);
      this.applyAppearance(this.appearance);

      await this.openWithResumeFallback(resumeTarget, gen);

      const summary = readBookSummary(book);
      this.emit({ type: "status", status: "idle" });
      return summary;
    } catch (error) {
      if (!this.isCurrent(gen)) {
        throw staleError();
      }
      const message = errorMessage(error);
      this.emit({ type: "status", status: "error", message });
      throw error instanceof Error ? error : new Error(message);
    } finally {
      this.endOp();
    }
  }

  async display(target?: string): Promise<void> {
    this.assertAlive();
    const gen = this.beginOp();
    this.emit({ type: "status", status: "loading" });
    // Do not teardown before navigation succeeds — a bad TOC href must keep
    // current-chapter gates/links/conversion alive (same pattern as next/prev).
    // Only reject a previously *bound* document — never the live contents
    // probe, which may be the same Document identity after a successful display.
    const staleDoc = this.lastBoundDocument;
    try {
      const rendition = this.requireRendition();
      await rendition.display(target);
      if (!this.isCurrent(gen)) return;
      this.teardownChapter();
      await this.afterChapterSettled(gen, { rejectDocument: staleDoc });
      if (!this.isCurrent(gen)) return;
      this.emit({ type: "status", status: "idle" });
    } catch (error) {
      if (!this.isCurrent(gen)) return;
      await this.rebindCurrentChapter();
      this.emit({
        type: "status",
        status: "error",
        message: errorMessage(error),
      });
      throw error;
    } finally {
      this.endOp();
    }
  }

  async goPrevious(): Promise<void> {
    await this.navigateAdjacent("prev");
  }

  async goNext(): Promise<void> {
    await this.navigateAdjacent("next");
  }

  private async navigateAdjacent(direction: "next" | "prev"): Promise<void> {
    this.assertAlive();
    const gen = this.beginOp();
    this.emit({ type: "status", status: "loading" });
    const before = this.snapshotTransition();
    try {
      const rendition = this.requireRendition();
      if (direction === "next") {
        await rendition.next();
      } else {
        await rendition.prev();
      }
      if (!this.isCurrent(gen)) return;

      // Prefer relocated/reportLocation result after next/prev promise settles.
      const nextLoc =
        (await this.awaitMeaningfulLocation(gen, before.location, 600)) ??
        (await this.readLocationFromRendition());
      if (!this.isCurrent(gen)) return;
      if (nextLoc) {
        this.location = nextLoc;
        this.emit({ type: "location", location: nextLoc });
      }

      const afterDoc =
        readContentsDocument(this.rendition) ||
        readIframeDocument(this.element);
      const after: TransitionSnapshot = {
        location: nextLoc ?? this.location,
        document: afterDoc,
        renderEpoch: this.renderEpoch,
        cfi: nextLoc?.cfi ?? this.location?.cfi,
        spineIndex: nextLoc?.spineIndex ?? this.location?.spineIndex,
        spineHref: nextLoc?.spineHref ?? this.location?.spineHref,
      };
      const kind = classifyTransition(before, after);

      if (kind === "same-spine-same-document") {
        // Keep converter baseline, revealed images, and chapter URLs.
        if (afterDoc && isChapterDocumentReady(afterDoc, this.rendition)) {
          this.lastBoundDocument = afterDoc;
          this.bindLiveChapterDocument(afterDoc);
          if (!this.converter.hasCaptureFor(afterDoc)) {
            this.converter.capture(afterDoc);
          }
          try {
            this.conversionGeneration += 1;
            await this.converter.apply(
              this.conversion,
              this.conversionGeneration,
            );
          } catch {
            // best-effort
          }
          this.repositionParentOverlays();
        }
      } else if (kind === "same-spine-replaced-document") {
        // New live DOM for same chapter — rebind; recapture only if needed.
        this.clearChapterGestures();
        this.clearParentImageGates();
        this.clearExternalLinkBridge();
        if (this.transformResult) {
          try {
            this.transformResult.dispose();
          } catch {
            // ignore
          }
          this.transformResult = null;
        }
        if (afterDoc && isChapterDocumentReady(afterDoc, this.rendition)) {
          await this.settleChapterDocument(afterDoc, gen, {
            forceCapture: !this.converter.hasCaptureFor(afterDoc),
          });
        }
      } else if (kind === "cross-spine") {
        this.teardownChapter();
        await this.afterChapterSettled(gen, {
          rejectDocument: before.document,
        });
      } else {
        // no-transition (boundary or stale): keep chapter usable
        await this.rebindCurrentChapter();
      }

      if (!this.isCurrent(gen)) return;
      this.emit({ type: "status", status: "idle" });
    } catch (error) {
      if (!this.isCurrent(gen)) return;
      await this.rebindCurrentChapter();
      this.emit({
        type: "status",
        status: "error",
        message: errorMessage(error),
      });
      throw error;
    } finally {
      this.endOp();
    }
  }

  private snapshotTransition(): TransitionSnapshot {
    const doc =
      this.lastBoundDocument ||
      readContentsDocument(this.rendition) ||
      readIframeDocument(this.element);
    return {
      location: this.location,
      document: doc,
      renderEpoch: this.renderEpoch,
      cfi: this.location?.cfi,
      spineIndex: this.location?.spineIndex,
      spineHref: this.location?.spineHref,
    };
  }

  /**
   * Wait for a relocated event that changes CFI/page/spine, or time out.
   * Does not treat a stale non-null rendition.location as success.
   */
  private awaitMeaningfulLocation(
    gen: number,
    prev: ReaderLocation | null | { cfi: string; spineHref: string; spineIndex: number; chapterPage: number } | null,
    timeoutMs: number,
  ): Promise<ReaderLocation | null> {
    const rendition = this.rendition;
    if (!rendition) return Promise.resolve(null);

    return new Promise((resolve) => {
      let settled = false;
      const finish = (loc: ReaderLocation | null) => {
        if (settled) return;
        settled = true;
        try {
          rendition.off?.("relocated", onRelocated);
        } catch {
          // ignore
        }
        resolve(loc);
      };

      const onRelocated = (raw: unknown) => {
        if (!this.isCurrent(gen) || this.rendition !== rendition) {
          finish(null);
          return;
        }
        const mapped = mapLocation(raw as AdaptedLocation, this.spineCount);
        if (!mapped) return;
        if (!locationMeaningfullyChanged(prev, mapped)) {
          // Stale non-null location from an earlier page — ignore.
          return;
        }
        finish(mapped);
      };

      try {
        rendition.on("relocated", onRelocated);
      } catch {
        finish(null);
        return;
      }

      // next()/prev() often already ran reportLocation before this await.
      void this.readLocationFromRendition().then((mapped) => {
        if (settled) return;
        if (!this.isCurrent(gen)) {
          finish(null);
          return;
        }
        if (mapped && locationMeaningfullyChanged(prev, mapped)) {
          finish(mapped);
        }
      });

      setTimeout(() => {
        if (settled) return;
        // Bounded fallback: accept current mapped location even if unchanged
        // (start/end of book).
        void this.readLocationFromRendition().then((mapped) => {
          finish(this.isCurrent(gen) ? mapped : null);
        });
      }, timeoutMs);
    });
  }

  private async openWithResumeFallback(
    resume: ResumeTarget,
    gen: number,
  ): Promise<void> {
    const cfi = resume.cfi?.includes("epubcfi") ? resume.cfi : undefined;
    const href = resume.spineHref?.trim() || undefined;

    if (cfi) {
      try {
        await this.displayInternal(undefined, gen);
        if (!this.isCurrent(gen)) throw staleError();
        await waitMs(50);
        await this.displayInternal(cfi, gen);
        if (!this.isCurrent(gen)) throw staleError();
        for (let attempt = 0; attempt < 3; attempt += 1) {
          if (!this.isCurrent(gen)) throw staleError();
          if (this.location?.cfi === cfi) return;
          await waitMs(60 * (attempt + 1));
          await this.displayInternal(cfi, gen);
        }
        if (this.location?.cfi === cfi) return;
      } catch {
        // Fall through to spine href / first item — never leave book unopenable.
      }
    }

    if (href) {
      try {
        await this.displayInternal(href, gen);
        if (!this.isCurrent(gen)) throw staleError();
        return;
      } catch {
        // Fall through to first spine item.
      }
    }

    await this.displayInternal(undefined, gen);
    if (!this.isCurrent(gen)) throw staleError();
  }

  resize(): void {
    // Never call beginOp() or rendition.display(cfi) — those races cancel open/nav
    // or rewound pages when a stale display resolved late.
    if (this.destroyed || !this.rendition) return;
    try {
      this.rendition.resize?.();
    } catch {
      // ignore geometry probe failures
    }
    this.scheduleResizeRebind();
  }

  async setFlow(flow: "paginated" | "scrolled"): Promise<void> {
    this.assertAlive();
    const gen = this.beginOp();
    this.flow = flow;
    this.emit({ type: "status", status: "loading" });

    try {
      const cfi = this.location?.cfi;
      const book = this.requireBook();

      this.detachRendition();
      this.teardownChapter();
      this.rendition = this.createRendition(book);
      this.wireRendition(this.rendition);
      this.applyAppearance(this.appearance);

      await this.displayInternal(cfi, gen);
      if (!this.isCurrent(gen)) return;
      this.emit({ type: "status", status: "idle" });
    } catch (error) {
      if (!this.isCurrent(gen)) return;
      this.emit({
        type: "status",
        status: "error",
        message: errorMessage(error),
      });
      throw error;
    } finally {
      this.endOp();
    }
  }

  async setConversion(mode: ConversionMode): Promise<void> {
    this.assertAlive();
    // Conversion must not bump navigation generation — doing so aborts
    // in-flight next/prev/display before afterChapterSettled rebinds gates.
    this.conversion = mode;
    this.conversionGeneration += 1;
    const convGen = this.conversionGeneration;
    try {
      await this.converter.apply(mode, convGen);
      if (this.destroyed || convGen !== this.conversionGeneration) return;
    } catch (error) {
      if (this.destroyed || convGen !== this.conversionGeneration) return;
      this.emit({
        type: "conversion-error",
        message: errorMessage(error),
      });
      throw error;
    }
  }

  applyAppearance(settings: AppearanceSettings): void {
    if (this.destroyed) return;
    this.appearance = { ...settings };
    const rendition = this.rendition;
    if (!rendition?.themes) return;

    const resolvedTheme = resolveTheme(settings.theme);
    const themeColors = THEME_COLORS[resolvedTheme];
    const background =
      resolvedTheme === "night"
        ? themeColors.background
        : BACKGROUNDS[settings.background];
    const color = themeColors.color;
    const marginPercent = Math.max(
      0,
      Math.min(20, Math.round(settings.horizontalMarginPercent ?? 4)),
    );
    const margin = `${marginPercent}%`;

    try {
      rendition.themes.fontSize(`${settings.fontSizePercent}%`);
      rendition.themes.font(FONT_STACKS[settings.fontFamily]);
      rendition.themes.override("color", color, true);
      rendition.themes.override("background-color", background, true);
      rendition.themes.override("background", background, true);
      rendition.themes.override("padding-left", margin, true);
      rendition.themes.override("padding-right", margin, true);
    } catch {
      // Themes may be unavailable before first render; settings are retained.
    }

    // Mirror margin on the host for chrome/CSS consumers.
    try {
      this.element.style.setProperty("--reader-h-margin", margin);
    } catch {
      // ignore
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.bumpGeneration();
    this.destroyed = true;
    this.inflightOps = 0;
    this.resizeToken += 1;
    if (this.resizeTimer !== null) {
      clearTimeout(this.resizeTimer);
      this.resizeTimer = null;
    }
    this.pendingRenderWaiters = [];
    this.pendingLateChapterRebindGen = null;
    this.listeners.clear();
    this.teardownChapter();
    this.detachRendition();
    void this.teardownBook();
    this.revokeOwnedObjectUrls();
    this.location = null;
    this.book = null;
    this.rendition = null;
    this.factory = null;
    this.lastBoundDocument = null;
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /**
   * Open/setFlow path: may teardown first because there is no user-visible
   * chapter that must survive a failed hop (or the caller already tore down).
   */
  private async displayInternal(
    target: string | undefined,
    gen: number,
  ): Promise<void> {
    // Reject only a previously bound chapter document. Using the live contents
    // Document as staleDoc is wrong when EPUB.js reuses the same identity after
    // display() — open/setFlow would never capture or bind.
    const staleDoc = this.lastBoundDocument;
    this.teardownChapter();
    const rendition = this.requireRendition();
    await rendition.display(target);
    if (!this.isCurrent(gen)) return;
    await this.afterChapterSettled(gen, { rejectDocument: staleDoc });
  }

  /**
   * Soft geometry rebind after layout. Primary path is rendered/relocated after
   * epubjs onResized; timer is only a bounded fallback (not the sole mechanism).
   */
  private scheduleResizeRebind(): void {
    if (this.resizeTimer !== null) {
      clearTimeout(this.resizeTimer);
    }
    this.resizeToken += 1;
    const token = this.resizeToken;
    // Arm late repair for engines that emit rendered well after resize.
    this.pendingLateChapterRebindGen = this.generation;
    this.resizeTimer = setTimeout(() => {
      this.resizeTimer = null;
      void this.runResizeRebind(token);
    }, 120);
  }

  private cancelResizeRebind(): void {
    this.resizeToken += 1;
    if (this.resizeTimer !== null) {
      clearTimeout(this.resizeTimer);
      this.resizeTimer = null;
    }
  }

  private async runResizeRebind(token: number): Promise<void> {
    if (this.destroyed || token !== this.resizeToken || !this.rendition) {
      return;
    }
    // Navigation / open owns settlement — do not fight for the chapter.
    if (this.inflightOps > 0) return;

    try {
      const beforeDoc = this.lastBoundDocument;
      const afterDoc =
        readContentsDocument(this.rendition) ||
        readIframeDocument(this.element);

      if (
        afterDoc &&
        beforeDoc &&
        afterDoc !== beforeDoc &&
        isChapterDocumentReady(afterDoc, this.rendition)
      ) {
        // New live DOM after epubjs view clear/redisplay.
        await this.settleChapterDocument(afterDoc, this.generation, {
          forceCapture: !this.converter.hasCaptureFor(afterDoc),
        });
      } else {
        // Same Document: preserve converter baseline; rebind chrome only.
        await this.rebindCurrentChapter();
      }
      if (this.destroyed || token !== this.resizeToken || this.inflightOps > 0) {
        return;
      }
      this.repositionParentOverlays();
    } catch {
      // best-effort geometry repair
    }
  }

  private async afterChapterSettled(
    gen: number,
    options?: { rejectDocument?: Document | null },
  ): Promise<void> {
    if (!this.isCurrent(gen)) return;

    // Only reject a document when the caller knows the section changed
    // (display/open/setFlow, or next/prev across a spine boundary).
    // In-chapter next/prev and resize rebind keep the same Document identity.
    const rejectDoc = options?.rejectDocument ?? null;
    let doc: Document | null = null;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const candidate =
        readContentsDocument(this.rendition) ||
        readIframeDocument(this.element);
      const isStale = Boolean(rejectDoc && candidate && candidate === rejectDoc);
      if (
        !isStale &&
        isChapterDocumentReady(candidate, this.rendition)
      ) {
        doc = candidate;
        break;
      }
      // Prefer waiting on the real rendered lifecycle when we still see the
      // previous document (or an empty shell).
      await Promise.race([waitMs(40), this.waitForNextRender(50)]);
      if (!this.isCurrent(gen)) return;
    }

    if (doc) {
      this.pendingLateChapterRebindGen = null;
      await this.settleChapterDocument(doc, gen, { forceCapture: true });
    } else if (this.isCurrent(gen)) {
      // Chapter may still be rendering; arm one-shot repair on later `rendered`.
      this.pendingLateChapterRebindGen = gen;
    }

    if (!this.isCurrent(gen)) return;
    await this.syncLocationFromRenditionAsync();
  }

  /**
   * Bind gates/gestures and apply conversion for a ready chapter document.
   * @param forceCapture when true, always recapture originals (new chapter).
   *   when false, preserve existing original map if already captured for `doc`.
   */
  private async settleChapterDocument(
    doc: Document,
    gen: number,
    options: { forceCapture: boolean },
  ): Promise<void> {
    if (!this.isCurrent(gen)) return;
    this.lastBoundDocument = doc;
    this.bindLiveChapterDocument(doc);

    if (options.forceCapture || !this.converter.hasCaptureFor(doc)) {
      this.converter.capture(doc);
    }

    try {
      this.conversionGeneration += 1;
      const convGen = this.conversionGeneration;
      await this.converter.apply(this.conversion, convGen);
    } catch (error) {
      if (!this.isCurrent(gen)) return;
      this.emit({
        type: "conversion-error",
        message: errorMessage(error),
      });
    }

    if (!this.isCurrent(gen)) return;
    // Re-bind once more after conversion mutations settle (WebKit srcdoc).
    this.bindLiveChapterDocument(doc);
  }

  private async lateChapterRebind(gen: number): Promise<void> {
    if (!this.isCurrent(gen) || this.destroyed) return;
    const candidate =
      readContentsDocument(this.rendition) ||
      readIframeDocument(this.element);
    if (!isChapterDocumentReady(candidate, this.rendition) || !candidate) {
      // Still empty — keep arming for a later rendered event.
      if (this.isCurrent(gen)) {
        this.pendingLateChapterRebindGen = gen;
      }
      return;
    }
    this.pendingLateChapterRebindGen = null;
    // New document path: must capture originals from the real chapter text.
    await this.settleChapterDocument(candidate, gen, { forceCapture: true });
    if (!this.isCurrent(gen)) return;
    await this.syncLocationFromRenditionAsync();
  }

  private waitForNextRender(timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      this.pendingRenderWaiters.push(finish);
      setTimeout(() => {
        const idx = this.pendingRenderWaiters.indexOf(finish);
        if (idx >= 0) this.pendingRenderWaiters.splice(idx, 1);
        finish();
      }, timeoutMs);
    });
  }

  /**
   * Re-attach gates/links/gestures for the still-visible chapter.
   * Does NOT recapture originals when the same document is already captured —
   * that would bake converted text in as the new “原文” baseline.
   */
  private async rebindCurrentChapter(): Promise<void> {
    const doc =
      readContentsDocument(this.rendition) ||
      readIframeDocument(this.element);
    if (!doc || !isChapterDocumentReady(doc, this.rendition)) return;
    await this.settleChapterDocument(doc, this.generation, {
      forceCapture: false,
    });
    await this.syncLocationFromRenditionAsync();
  }

  private bindLiveChapterDocument(doc: Document): void {
    // Listeners attached in spine.hooks.content are lost when EPUB.js
    // serializes the section into the iframe. Rebind gates on the live DOM.
    if (this.transformResult) {
      try {
        this.transformResult.dispose();
      } catch {
        // ignore
      }
      this.transformResult = null;
    }
    this.clearChapterGestures();
    const materialize = this.makeMaterialize();
    this.transformResult = rebindImageGates(doc, {
      materializeArchiveUrl: materialize,
    });
    this.installExternalLinkBridge(doc);
    // Sandbox without allow-scripts: in-iframe listeners are unreliable on
    // WebKit. Parent-document overlay buttons receive real clicks safely.
    this.installParentImageGates(doc, materialize);
    this.installParentExternalLinks(doc);
    // Touch/click inside the chapter iframe do not bubble to the parent —
    // attach gestures on the live chapter document.
    this.installChapterGestures(doc);
    // Inject package CSS as sanitized <style> (archive-wide replacements off).
    if (materialize) {
      void injectPackageStylesheets(doc, materialize).then(() => {
        this.repositionParentOverlays();
      });
    }
  }

  private clearChapterGestures(): void {
    if (this.chapterGestureDisposer) {
      try {
        this.chapterGestureDisposer();
      } catch {
        // ignore
      }
      this.chapterGestureDisposer = null;
    }
  }

  /**
   * Swipe page-turn + content tap (chrome toggle) from inside the EPUB iframe.
   */
  private installChapterGestures(doc: Document): void {
    this.clearChapterGestures();
    let touchStart: { x: number; y: number; time: number } | null = null;
    let suppressTap = false;

    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 1) {
        touchStart = null;
        return;
      }
      const touch = event.touches[0]!;
      touchStart = {
        x: touch.clientX,
        y: touch.clientY,
        time: Date.now(),
      };
    };

    const onTouchEnd = (event: TouchEvent) => {
      const start = touchStart;
      touchStart = null;
      if (!start || event.changedTouches.length === 0) return;
      if (this.flow !== "paginated") return;
      const touch = event.changedTouches[0]!;
      const direction = classifySwipe({
        startX: start.x,
        startY: start.y,
        endX: touch.clientX,
        endY: touch.clientY,
        durationMs: Date.now() - start.time,
      });
      if (!direction) return;
      suppressTap = true;
      if (direction === "left") {
        void this.goNext().catch(() => {
          // status already emitted
        });
      } else {
        void this.goPrevious().catch(() => {
          // status already emitted
        });
      }
    };

    const onTouchCancel = () => {
      touchStart = null;
    };

    const onClick = (event: Event) => {
      if (suppressTap) {
        suppressTap = false;
        return;
      }
      const target = eventTargetElement(event.target);
      if (!target) return;
      // Ignore interactive chapter controls (gates, anchors).
      if (closestElement(target, "a, button, input, textarea, select, label")) {
        return;
      }
      this.emit({ type: "content-tap" });
    };

    doc.addEventListener("touchstart", onTouchStart, { passive: true });
    doc.addEventListener("touchend", onTouchEnd, { passive: true });
    doc.addEventListener("touchcancel", onTouchCancel, { passive: true });
    doc.addEventListener("click", onClick);

    this.chapterGestureDisposer = () => {
      doc.removeEventListener("touchstart", onTouchStart);
      doc.removeEventListener("touchend", onTouchEnd);
      doc.removeEventListener("touchcancel", onTouchCancel);
      doc.removeEventListener("click", onClick);
    };
  }

  private clearParentOverlaysTimer(): void {
    if (this.parentOverlayRepositionTimer !== null) {
      clearInterval(this.parentOverlayRepositionTimer);
      this.parentOverlayRepositionTimer = null;
    }
  }

  /**
   * True when an iframe-local rect is large enough and intersects the iframe
   * viewport. Used so we never park ghost "點擊顯示圖片" controls at a fixed
   * stage corner when the image is off-page, unloaded, or 0×0.
   */
  private isIframeLocalRectVisible(
    rect: DOMRect,
    iframe: HTMLIFrameElement,
  ): boolean {
    const vw = iframe.clientWidth || iframe.getBoundingClientRect().width;
    const vh = iframe.clientHeight || iframe.getBoundingClientRect().height;
    if (rect.width < 4 || rect.height < 4) return false;
    // Ignore 1×1 / spacer tracking pixels even if attributes inflate layout.
    if (rect.width <= 2 && rect.height <= 2) return false;
    if (rect.width < 8 && rect.height < 8) return false;
    // Intersect the iframe's client viewport (rect is iframe-local).
    if (rect.bottom <= 0 || rect.right <= 0) return false;
    if (rect.top >= vh || rect.left >= vw) return false;
    return true;
  }

  private hideParentOverlayButton(button: HTMLButtonElement): void {
    button.style.visibility = "hidden";
    button.style.pointerEvents = "none";
  }

  /** Parent overlay owns the control — remove iframe twin from a11y + keyboard. */
  private hideInFrameGateForParent(inFrameButton: HTMLElement): void {
    if (inFrameButton.tagName.toLowerCase() !== "button") return;
    inFrameButton.hidden = true;
    inFrameButton.setAttribute("aria-hidden", "true");
    inFrameButton.tabIndex = -1;
    inFrameButton.style.pointerEvents = "none";
    inFrameButton.style.opacity = "0";
  }

  /** Parent overlay off-viewport — restore iframe gate as the sole control. */
  private showInFrameGateFallback(inFrameButton: HTMLElement): void {
    if (inFrameButton.tagName.toLowerCase() !== "button") return;
    inFrameButton.hidden = false;
    inFrameButton.setAttribute("aria-hidden", "false");
    inFrameButton.removeAttribute("tabindex");
    inFrameButton.style.pointerEvents = "auto";
    inFrameButton.style.opacity = "1";
  }

  private showParentOverlayButton(
    button: HTMLButtonElement,
    left: number,
    top: number,
  ): void {
    button.style.left = `${Math.max(0, left)}px`;
    button.style.top = `${Math.max(0, top)}px`;
    button.style.visibility = "visible";
    button.style.pointerEvents = "auto";
  }

  /** Reposition all parent overlays (image gates + external links). */
  private repositionParentOverlays(): void {
    if (typeof document === "undefined") return;
    const iframe = this.element.querySelector("iframe");
    if (!iframe) return;
    const iframeRect = iframe.getBoundingClientRect();

    for (const pair of this.parentGatePairs) {
      try {
        // Already revealed — remove ghost control.
        const liveSrc = pair.img.getAttribute("src") || "";
        if (liveSrc.startsWith("blob:") || liveSrc.startsWith("data:")) {
          this.hideParentOverlayButton(pair.button);
          pair.button.hidden = true;
          continue;
        }
        const rect = pair.img.getBoundingClientRect();
        if (!this.isIframeLocalRectVisible(rect, iframe)) {
          // Do NOT park at stage corner — that produced a floating gate on
          // every section when images were off-page or not laid out yet.
          this.hideParentOverlayButton(pair.button);
          // In-frame button is the only accessible/tappable control.
          try {
            this.showInFrameGateFallback(pair.inFrameButton);
          } catch {
            // ignore
          }
          continue;
        }
        const left = iframeRect.left + rect.left;
        const top = iframeRect.top + rect.top - 48;
        pair.button.hidden = false;
        this.showParentOverlayButton(pair.button, left, top);
        // Prefer parent hit target; fully hide in-frame control from a11y tree.
        try {
          this.hideInFrameGateForParent(pair.inFrameButton);
        } catch {
          // ignore
        }
      } catch {
        this.hideParentOverlayButton(pair.button);
      }
    }

    for (const pair of this.parentExternalLinks) {
      try {
        const rect = pair.anchor.getBoundingClientRect();
        if (!this.isIframeLocalRectVisible(rect, iframe)) {
          this.hideParentOverlayButton(pair.button);
          continue;
        }
        const left = iframeRect.left + rect.left;
        const top = iframeRect.top + rect.top;
        pair.button.style.width = `${Math.max(44, rect.width)}px`;
        pair.button.style.height = `${Math.max(44, rect.height)}px`;
        pair.button.hidden = false;
        this.showParentOverlayButton(pair.button, left, top);
      } catch {
        this.hideParentOverlayButton(pair.button);
      }
    }
  }

  private ensureParentOverlayTimer(): void {
    // Low-frequency fallback only — primary path is event/rAF driven.
    if (this.parentOverlayRepositionTimer !== null) return;
    if (
      this.parentGatePairs.length === 0 &&
      this.parentExternalLinks.length === 0
    ) {
      return;
    }
    this.parentOverlayRepositionTimer = setInterval(() => {
      if (
        this.parentGatePairs.length === 0 &&
        this.parentExternalLinks.length === 0
      ) {
        this.clearParentOverlaysTimer();
        return;
      }
      this.repositionParentOverlays();
    }, 1000);
  }

  private clearParentImageGates(): void {
    for (const pair of this.parentGatePairs) {
      try {
        pair.button.remove();
      } catch {
        // ignore
      }
    }
    this.parentGatePairs = [];
    if (
      this.parentExternalLinks.length === 0 &&
      this.parentGatePairs.length === 0
    ) {
      this.clearParentOverlaysTimer();
    }
  }

  private clearParentExternalLinks(): void {
    for (const pair of this.parentExternalLinks) {
      try {
        pair.button.remove();
      } catch {
        // ignore
      }
    }
    this.parentExternalLinks = [];
    if (this.parentGatePairs.length === 0) {
      this.clearParentOverlaysTimer();
    }
  }

  private clearExternalLinkBridge(): void {
    if (this.externalLinkDisposer) {
      try {
        this.externalLinkDisposer();
      } catch {
        // ignore
      }
      this.externalLinkDisposer = null;
    }
    this.clearParentExternalLinks();
  }

  private openExternalHref(href: string): void {
    const trimmed = href.trim();
    if (!trimmed) return;
    const lower = trimmed.toLowerCase();
    let absolute = trimmed;
    if (lower.startsWith("//")) {
      absolute = `https:${trimmed}`;
    } else if (!lower.startsWith("http:") && !lower.startsWith("https:")) {
      return;
    }
    try {
      window.open(absolute, "_blank", "noopener,noreferrer");
    } catch {
      // Popup blocked — leave inert.
    }
  }

  /**
   * In-iframe capture bridge for engines that deliver clicks to content
   * listeners. WebKit often does not; parent overlays cover that path.
   */
  private installExternalLinkBridge(doc: Document): void {
    this.clearExternalLinkBridge();
    const onClick = (event: Event): void => {
      const target = eventTargetElement(event.target);
      if (!target) return;
      const anchor = closestElement(target, "a[data-epub-external='1']");
      if (!anchor) return;
      const href = (anchor.getAttribute("href") || "").trim();
      if (!href) return;
      event.preventDefault();
      event.stopPropagation();
      this.openExternalHref(href);
    };
    doc.addEventListener("click", onClick, true);
    this.externalLinkDisposer = () => {
      doc.removeEventListener("click", onClick, true);
    };
  }

  /**
   * Parent fixed hit-targets over external anchors — required on WebKit where
   * sandboxed chapter documents do not reliably fire scripted click handlers.
   */
  private installParentExternalLinks(doc: Document): void {
    this.clearParentExternalLinks();
    if (typeof document === "undefined") return;
    const iframe = this.element.querySelector("iframe");
    if (!iframe) return;

    const anchors = Array.from(
      doc.querySelectorAll("a[data-epub-external='1']"),
    );
    for (const anchor of anchors) {
      const href = (anchor.getAttribute("href") || "").trim();
      if (!href) continue;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "epub-parent-external-link touch-target";
      button.setAttribute(
        "aria-label",
        `開啟外部連結：${href}`,
      );
      button.textContent = anchor.textContent?.trim() || "外部連結";
      button.style.position = "fixed";
      // Above parent image gates (z-index 20) so a mis-parked gate cannot steal taps.
      button.style.zIndex = "21";
      button.style.minWidth = "44px";
      button.style.minHeight = "44px";
      button.style.pointerEvents = "auto";
      button.style.maxWidth = "16rem";
      button.style.visibility = "hidden";
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.openExternalHref(href);
      });
      document.body.appendChild(button);
      this.parentExternalLinks.push({ anchor, button, href });
      // Prefer parent control; keep in-frame link for semantics only.
      try {
        (anchor as HTMLElement).style.pointerEvents = "none";
      } catch {
        // ignore
      }
    }

    this.repositionParentOverlays();
    requestAnimationFrame(() => this.repositionParentOverlays());
    this.ensureParentOverlayTimer();
  }

  /**
   * Place parent-document gate controls over gated images inside the iframe.
   * Coordinates map iframe-local getBoundingClientRect() into the top document
   * by adding the iframe's own rect (required for position:fixed overlays).
   */
  private installParentImageGates(
    doc: Document,
    materialize?: (packagePath: string) => Promise<string | null>,
  ): void {
    this.clearParentImageGates();
    if (typeof document === "undefined") return;
    const iframe = this.element.querySelector("iframe");
    if (!iframe || !materialize) return;

    const candidates: Array<{
      img: HTMLImageElement;
      inFrameButton: HTMLElement;
    }> = [];
    for (const img of Array.from(
      doc.querySelectorAll("img[data-epub-src]"),
    ) as HTMLImageElement[]) {
      const prev = img.previousElementSibling;
      if (!prev || prev.tagName.toLowerCase() !== "button") continue;
      const label = prev.getAttribute("aria-label") || "";
      const text = prev.textContent?.trim() || "";
      if (!label.includes("點擊顯示圖片") && !text.includes("點擊顯示圖片")) {
        continue;
      }
      const inFrameButton = prev as HTMLElement;
      candidates.push({ img, inFrameButton });
      // Keep in-frame control as fallback when parent overlay is off-viewport.
      inFrameButton.setAttribute("aria-hidden", "false");
      inFrameButton.hidden = false;
      inFrameButton.style.pointerEvents = "auto";
      inFrameButton.style.opacity = "1";
    }

    if (candidates.length === 0) {
      // Fallback: gated images without a sibling button (serialization quirks).
      for (const img of Array.from(
        doc.querySelectorAll("img[data-epub-src]"),
      ) as HTMLImageElement[]) {
        candidates.push({ img, inFrameButton: img as unknown as HTMLElement });
      }
    }

    for (const candidate of candidates) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = "點擊顯示圖片";
      button.setAttribute("aria-label", "點擊顯示圖片");
      button.className = "epub-parent-image-gate touch-target";
      button.style.position = "fixed";
      // Stay below app chrome/TOC drawers (typically z-index 100+).
      button.style.zIndex = "20";
      button.style.minWidth = "44px";
      button.style.minHeight = "44px";
      button.style.pointerEvents = "auto";
      button.style.maxWidth = "12rem";
      button.style.visibility = "hidden";
      const pair = {
        img: candidate.img,
        inFrameButton: candidate.inFrameButton,
        button,
      };
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        void (async () => {
          const path = pair.img.getAttribute("data-epub-src");
          if (!path) return;
          const url = await materialize(path);
          if (!url || (!url.startsWith("blob:") && !url.startsWith("data:"))) {
            button.textContent = "圖片載入失敗，點擊重試";
            return;
          }
          pair.img.setAttribute("src", url);
          if (pair.inFrameButton !== pair.img) {
            pair.inFrameButton.hidden = true;
          }
          button.remove();
          const idx = this.parentGatePairs.indexOf(pair);
          if (idx >= 0) this.parentGatePairs.splice(idx, 1);
        })();
      });
      document.body.appendChild(button);
      this.parentGatePairs.push(pair);
    }
    this.repositionParentOverlays();
    requestAnimationFrame(() => this.repositionParentOverlays());
    this.ensureParentOverlayTimer();
  }

  private makeMaterialize():
    | ((packagePath: string) => Promise<string | null>)
    | undefined {
    const book = this.book;
    if (!book) return undefined;
    return (packagePath: string) => {
      const key = packagePath.trim();
      if (!key) return Promise.resolve(null);

      const existing = this.chapterMaterializations.get(key);
      if (existing) return existing;

      const generation = this.chapterMaterializationGeneration;
      let pending!: Promise<string | null>;
      pending = materializeArchiveUrl(book, key, this.chapterObjectUrls)
        .then((url) => {
          const stale =
            this.destroyed ||
            this.book !== book ||
            this.chapterMaterializationGeneration !== generation;
          if (stale) {
            if (url?.startsWith("blob:")) {
              this.chapterObjectUrls.delete(url);
              disposeMaterializedUrl(book, url, [key]);
            }
            return null;
          }
          if (url?.startsWith("blob:")) {
            this.ownedObjectUrls.add(url);
          }
          return url;
        })
        .finally(() => {
          if (this.chapterMaterializations.get(key) === pending) {
            this.chapterMaterializations.delete(key);
          }
        });
      this.chapterMaterializations.set(key, pending);
      return pending;
    };
  }

  private createRendition(book: AdaptedBook): AdaptedRendition {
    const options: RenditionCreateOptions = {
      ...DEFAULT_RENDITION_OPTIONS,
      flow: this.flow === "scrolled" ? "scrolled-doc" : "paginated",
      spread: "none",
      allowScriptedContent: false,
      width: "100%",
      height: "100%",
    };

    const rendition = book.renderTo(this.element, options);
    if (rendition.settings) {
      rendition.settings.allowScriptedContent = false;
    }
    return rendition;
  }

  private wireRendition(rendition: AdaptedRendition): void {
    this.relocatedHandler = (loc: unknown) => {
      if (this.destroyed) return;
      // Ignore relocated events that race with in-flight display/nav/open/flow.
      // Settled ops publish location explicitly via afterChapterSettled.
      if (this.inflightOps > 0) return;
      const mapped = mapLocation(loc as AdaptedLocation, this.spineCount);
      if (!mapped) return;
      this.location = mapped;
      this.emit({ type: "location", location: mapped });
    };
    rendition.on("relocated", this.relocatedHandler);

    this.renderedHandler = () => {
      // Signal chapter document replacement so readiness polling can reject
      // the previous non-empty document and wait for the new one.
      this.renderEpoch += 1;
      const waiters = this.pendingRenderWaiters.splice(0);
      for (const waiter of waiters) {
        try {
          waiter();
        } catch {
          // ignore
        }
      }
      // Late repair: chapter finished rendering after settle polling timed out.
      const lateGen = this.pendingLateChapterRebindGen;
      if (
        lateGen !== null &&
        lateGen === this.generation &&
        !this.destroyed &&
        this.rendition === rendition
      ) {
        this.pendingLateChapterRebindGen = null;
        void this.lateChapterRebind(lateGen);
      }
    };
    rendition.on("rendered", this.renderedHandler);
  }

  private detachRendition(): void {
    if (this.rendition) {
      if (this.relocatedHandler) {
        try {
          this.rendition.off("relocated", this.relocatedHandler);
        } catch {
          // ignore
        }
      }
      if (this.renderedHandler) {
        try {
          this.rendition.off("rendered", this.renderedHandler);
        } catch {
          // ignore
        }
      }
      try {
        this.rendition.destroy();
      } catch {
        // ignore
      }
    }
    this.rendition = null;
    this.relocatedHandler = null;
    this.renderedHandler = null;
  }

  private registerSpineTransform(book: AdaptedBook): void {
    const hook = (...args: unknown[]): void => {
      const doc = args[0];
      if (!doc || typeof doc !== "object") return;
      const document = doc as Document;
      const section = args[1] as { href?: string } | undefined;
      const sectionHref =
        typeof section?.href === "string" ? section.href : undefined;
      // Dispose previous chapter transform listeners before replacing chapter.
      if (this.transformResult) {
        try {
          this.transformResult.dispose();
        } catch {
          // ignore
        }
        this.transformResult = null;
      }
      this.revokeChapterObjectUrls();
      const resolve = createArchiveResolver(book, undefined, sectionHref);
      const materialize = this.makeMaterialize();
      this.transformResult = transformChapter(document, resolve, {
        materializeArchiveUrl: materialize,
        sectionHref,
      });
    };
    this.spineContentHook = hook;
    book.spine.hooks.content.register(hook);
  }

  private teardownChapter(): void {
    this.converter.destroy();
    this.clearChapterGestures();
    this.clearParentImageGates();
    this.clearExternalLinkBridge();
    if (this.transformResult) {
      try {
        this.transformResult.dispose();
      } catch {
        // ignore
      }
      this.transformResult = null;
    }
    this.revokeChapterObjectUrls();
  }

  private revokeChapterObjectUrls(): void {
    this.chapterMaterializationGeneration += 1;
    this.chapterMaterializations.clear();
    const revoke = getRevokeObjectURL();
    const revoked: string[] = [];
    for (const url of this.chapterObjectUrls) {
      try {
        revoke(url);
      } catch {
        // ignore
      }
      this.ownedObjectUrls.delete(url);
      revoked.push(url);
    }
    this.chapterObjectUrls.clear();
    // EPUB.js caches createUrl results; purge dead blobs so re-entry re-creates.
    if (this.book && revoked.length > 0) {
      purgeArchiveUrlCache(this.book, revoked);
    }
  }

  private async teardownBook(): Promise<void> {
    this.detachRendition();
    this.teardownChapter();

    if (this.book && this.spineContentHook) {
      try {
        this.book.spine.hooks.content.deregister?.(this.spineContentHook);
      } catch {
        // ignore
      }
    }
    this.spineContentHook = null;

    if (this.book) {
      try {
        this.book.destroy();
      } catch {
        // ignore
      }
    }
    this.book = null;
    this.spineCount = 0;
  }

  private revokeOwnedObjectUrls(): void {
    const revoke = getRevokeObjectURL();
    for (const url of this.ownedObjectUrls) {
      try {
        revoke(url);
      } catch {
        // ignore
      }
    }
    this.ownedObjectUrls.clear();
  }

  /**
   * Track an application-created object URL for revoke-on-destroy.
   * Exposed for tests via optional factory helpers; production open uses
   * ArrayBuffer so the book itself does not need a blob URL.
   */
  trackObjectUrl(url: string): void {
    if (url.startsWith("blob:")) {
      this.ownedObjectUrls.add(url);
    }
  }

  /**
   * Resolve the current location, awaiting Promise-returning currentLocation().
   * Callers that branch on spine changes (next/prev) must use this, not the
   * fire-and-forget sync helper.
   */
  private async readLocationFromRendition(): Promise<ReaderLocation | null> {
    const rendition = this.rendition;
    if (!rendition) return null;

    const raw = rendition.location ?? null;
    if (raw) {
      return mapLocation(raw, this.spineCount);
    }

    const current = rendition.currentLocation?.();
    if (!current) return null;

    if (typeof (current as Promise<unknown>).then === "function") {
      try {
        const loc = await (current as Promise<AdaptedLocation | undefined>);
        if (!loc) return null;
        return mapLocation(loc, this.spineCount);
      } catch {
        return null;
      }
    }

    return mapLocation(current as AdaptedLocation, this.spineCount);
  }

  private async syncLocationFromRenditionAsync(): Promise<void> {
    const mapped = await this.readLocationFromRendition();
    if (!mapped || this.destroyed) return;
    this.location = mapped;
    this.emit({ type: "location", location: mapped });
  }

  private syncLocationFromRendition(): void {
    // Sync path used from sync contexts (relocated handler). Prefer sync
    // location field; async currentLocation is still fire-and-forget here.
    const rendition = this.rendition;
    if (!rendition) return;
    const gen = this.generation;

    const raw = rendition.location ?? null;
    if (raw) {
      const mapped = mapLocation(raw, this.spineCount);
      if (mapped) {
        this.location = mapped;
        this.emit({ type: "location", location: mapped });
        return;
      }
    }

    const current = rendition.currentLocation?.();
    if (current && typeof (current as Promise<unknown>).then === "function") {
      void (current as Promise<AdaptedLocation | undefined>).then((loc) => {
        if (this.destroyed || !this.isCurrent(gen) || this.rendition !== rendition) {
          return;
        }
        if (!loc) return;
        const mapped = mapLocation(loc, this.spineCount);
        if (mapped) {
          this.location = mapped;
          this.emit({ type: "location", location: mapped });
        }
      });
      return;
    }
    if (current) {
      const mapped = mapLocation(current as AdaptedLocation, this.spineCount);
      if (mapped) {
        this.location = mapped;
        this.emit({ type: "location", location: mapped });
      }
    }
  }

  private async ensureFactory(): Promise<EpubFactory> {
    if (this.injectedFactory) {
      return this.injectedFactory;
    }
    if (this.factory) {
      return this.factory;
    }
    this.factory = await this.loadFactory();
    return this.factory;
  }

  private bumpGeneration(): number {
    this.generation += 1;
    return this.generation;
  }

  private beginOp(): number {
    // Cancel pending/in-flight resize rebind so it cannot rebind or race after
    // navigation has claimed ownership (token invalidation; no display to cancel).
    this.cancelResizeRebind();
    // Invalidate any late-render repair armed for a previous chapter.
    this.pendingLateChapterRebindGen = null;
    this.inflightOps += 1;
    return this.bumpGeneration();
  }

  private endOp(): void {
    if (this.inflightOps > 0) {
      this.inflightOps -= 1;
    }
  }

  private isCurrent(gen: number): boolean {
    return !this.destroyed && gen === this.generation;
  }

  private assertAlive(): void {
    if (this.destroyed) {
      throw new Error("ReaderSession has been destroyed");
    }
  }

  private requireRendition(): AdaptedRendition {
    if (!this.rendition) {
      throw new Error("No active rendition");
    }
    return this.rendition;
  }

  private requireBook(): AdaptedBook {
    if (!this.book) {
      throw new Error("No open book");
    }
    return this.book;
  }

  private emit(event: ReaderEvent): void {
    if (this.destroyed) return;
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Listener errors must not break the session.
      }
    }
  }
}

// Re-export track helper type-safe surface for tests that create blob URLs
// through the session's ownership set via a test-only factory.

function readSpineCount(book: AdaptedBook): number {
  if (typeof book.spine.length === "number" && book.spine.length > 0) {
    return book.spine.length;
  }
  if (Array.isArray(book.spine.spineItems)) {
    return book.spine.spineItems.length;
  }
  let count = 0;
  if (typeof book.spine.each === "function") {
    book.spine.each(() => {
      count += 1;
    });
    return count;
  }
  // Probe linear indices.
  for (let i = 0; i < 10_000; i += 1) {
    const section = book.spine.get(i);
    if (!section) break;
    count += 1;
  }
  return count;
}

function readBookSummary(book: AdaptedBook): BookSummary {
  const meta = book.packaging?.metadata;
  const title = meta?.title?.trim() || "Untitled";
  const creator = meta?.creator?.trim() || undefined;
  const toc = flattenToc(book.navigation?.toc ?? []);
  return creator ? { title, creator, toc } : { title, toc };
}

function flattenToc(
  items: AdaptedNavItem[],
): Array<{ label: string; href: string }> {
  const out: Array<{ label: string; href: string }> = [];
  const walk = (list: AdaptedNavItem[]): void => {
    for (const item of list) {
      out.push({ label: item.label, href: item.href });
      if (item.subitems && item.subitems.length > 0) {
        walk(item.subitems);
      }
    }
  };
  walk(items);
  return out;
}

function mapLocation(
  loc: AdaptedLocation | null | undefined,
  spineCount: number,
): ReaderLocation | null {
  if (!loc || !loc.start) return null;
  const start = loc.start;
  const cfi = start.cfi || "";
  const spineHref = start.href || "";
  const spineIndex = typeof start.index === "number" ? start.index : 0;
  const chapterPage = start.displayed?.page ?? 1;
  const chapterPages = Math.max(1, start.displayed?.total ?? 1);
  const count = Math.max(1, spineCount || 1);
  const approximatePercent = computeApproximatePercent(
    spineIndex,
    count,
    chapterPage,
    chapterPages,
  );

  return {
    cfi,
    spineHref,
    spineIndex,
    spineCount: count,
    chapterPage,
    chapterPages,
    approximatePercent,
  };
}

function computeApproximatePercent(
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

function readContentsDocument(
  rendition: AdaptedRendition | null,
): Document | null {
  if (!rendition || typeof rendition.getContents !== "function") {
    return null;
  }
  try {
    const contents = rendition.getContents();
    if (!contents) return null;
    const first = Array.isArray(contents) ? contents[0] : contents;
    if (!first) return null;
    if (first.document) return first.document;
    if (first.content && (first.content as Document).nodeType === 9) {
      return first.content as Document;
    }
    if (first.content && (first.content as Element).ownerDocument) {
      return (first.content as Element).ownerDocument;
    }
  } catch {
    return null;
  }
  return null;
}

/** True when the document has real chapter content, not an empty iframe shell. */
function isChapterDocumentReady(
  doc: Document | null | undefined,
  rendition: AdaptedRendition | null,
): boolean {
  if (!doc?.body) return false;
  if (doc.body.childNodes.length === 0) return false;
  const fromRendition = readContentsDocument(rendition);
  if (fromRendition && fromRendition !== doc) {
    // Prefer the live contents document when available.
    if (fromRendition.body && fromRendition.body.childNodes.length > 0) {
      return false;
    }
  }
  const hasElement = Boolean(
    doc.body.querySelector(
      "p, h1, h2, h3, h4, h5, h6, div, section, article, img, svg, span, a, li, blockquote",
    ),
  );
  if (hasElement) return true;
  return Array.from(doc.body.childNodes).some(
    (node) =>
      node.nodeType === 3 && Boolean(node.textContent && node.textContent.trim()),
  );
}

function readIframeDocument(host: HTMLElement | null): Document | null {
  if (!host) return null;
  try {
    const iframe = host.querySelector("iframe");
    return iframe?.contentDocument ?? null;
  } catch {
    return null;
  }
}

function resolveTheme(
  theme: AppearanceSettings["theme"],
): "day" | "night" {
  if (theme === "day") return "day";
  if (theme === "night") return "night";
  if (typeof window !== "undefined" && window.matchMedia) {
    try {
      if (window.matchMedia("(prefers-color-scheme: dark)").matches) {
        return "night";
      }
    } catch {
      // ignore
    }
  }
  return "day";
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

function normalizeResume(
  resume: string | ResumeTarget | undefined,
): ResumeTarget {
  if (resume == null) return {};
  if (typeof resume === "string") {
    return { cfi: resume };
  }
  return {
    ...(resume.cfi ? { cfi: resume.cfi } : {}),
    ...(resume.spineHref ? { spineHref: resume.spineHref } : {}),
    ...(typeof resume.approximatePercent === "number"
      ? { approximatePercent: resume.approximatePercent }
      : {}),
  };
}

function staleError(): Error {
  return new Error("ReaderSession operation superseded");
}

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function getRevokeObjectURL(): (url: string) => void {
  if (typeof URL !== "undefined" && typeof URL.revokeObjectURL === "function") {
    return (url) => URL.revokeObjectURL(url);
  }
  if (
    typeof window !== "undefined" &&
    window.URL &&
    typeof window.URL.revokeObjectURL === "function"
  ) {
    return (url) => window.URL.revokeObjectURL(url);
  }
  return () => {
    // no-op
  };
}

/** Test helper: create and track a blob object URL owned by the session. */
export function createOwnedObjectURL(
  session: ReaderSession,
  blob: Blob,
): string {
  const url = URL.createObjectURL(blob);
  const impl = session as ReaderSessionImpl;
  if (typeof impl.trackObjectUrl === "function") {
    impl.trackObjectUrl(url);
  }
  return url;
}
