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
  transformChapter,
  type ChapterTransformResult,
} from "./chapter-transformer";
import {
  createArchiveResolver,
  DEFAULT_RENDITION_OPTIONS,
  loadEpubFactory,
  type AdaptedBook,
  type AdaptedLocation,
  type AdaptedNavItem,
  type AdaptedRendition,
  type EpubFactory,
  type RenditionCreateOptions,
} from "./epub-adapter";

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
}

export type ReaderEvent =
  | { type: "location"; location: ReaderLocation }
  | { type: "status"; status: "idle" | "loading" | "error"; message?: string }
  | { type: "conversion-error"; message: string };

export interface ReaderSession {
  open(source: Blob, resumeCfi?: string): Promise<BookSummary>;
  display(target?: string): Promise<void>;
  goPrevious(): Promise<void>;
  goNext(): Promise<void>;
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

class ReaderSessionImpl implements ReaderSession {
  private readonly element: HTMLElement;
  private readonly injectedFactory: EpubFactory | undefined;
  private readonly loadFactory: () => Promise<EpubFactory>;
  private readonly persistence: "durable" | "session-only";

  private factory: EpubFactory | null = null;
  private book: AdaptedBook | null = null;
  private rendition: AdaptedRendition | null = null;
  private generation = 0;
  private destroyed = false;
  private location: ReaderLocation | null = null;
  private conversion: ConversionMode;
  private flow: "paginated" | "scrolled";
  private appearance: AppearanceSettings;
  private readonly listeners = new Set<(event: ReaderEvent) => void>();
  private readonly ownedObjectUrls = new Set<string>();
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

  async open(source: Blob, resumeCfi?: string): Promise<BookSummary> {
    this.assertAlive();
    const gen = this.beginOp();
    this.emit({ type: "status", status: "loading" });
    this.resumeCfi = resumeCfi;

    try {
      await this.teardownBook();
      if (!this.isCurrent(gen)) {
        throw staleError();
      }

      const buffer = await source.arrayBuffer();
      if (!this.isCurrent(gen)) {
        throw staleError();
      }

      const factory = await this.ensureFactory();
      if (!this.isCurrent(gen)) {
        throw staleError();
      }

      const book = factory(buffer, { replacements: "blobUrl" });
      this.book = book;
      this.registerSpineTransform(book);

      await book.ready;
      if (!this.isCurrent(gen)) {
        throw staleError();
      }

      this.spineCount = readSpineCount(book);
      this.rendition = this.createRendition(book);
      this.wireRendition(this.rendition);
      this.applyAppearance(this.appearance);

      const target = resumeCfi;
      await this.displayInternal(target, gen);
      if (!this.isCurrent(gen)) {
        throw staleError();
      }

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
    try {
      await this.displayInternal(target, gen);
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

  async goPrevious(): Promise<void> {
    this.assertAlive();
    const gen = this.beginOp();
    this.emit({ type: "status", status: "loading" });
    try {
      this.teardownChapter();
      const rendition = this.requireRendition();
      await rendition.prev();
      if (!this.isCurrent(gen)) return;
      await this.afterChapterSettled(gen);
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

  async goNext(): Promise<void> {
    this.assertAlive();
    const gen = this.beginOp();
    this.emit({ type: "status", status: "loading" });
    try {
      this.teardownChapter();
      const rendition = this.requireRendition();
      await rendition.next();
      if (!this.isCurrent(gen)) return;
      await this.afterChapterSettled(gen);
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
    const gen = this.beginOp();
    this.conversion = mode;
    try {
      await this.converter.apply(mode, gen);
      if (!this.isCurrent(gen)) return;
    } catch (error) {
      if (!this.isCurrent(gen)) return;
      this.emit({
        type: "conversion-error",
        message: errorMessage(error),
      });
      throw error;
    } finally {
      this.endOp();
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

    try {
      rendition.themes.fontSize(`${settings.fontSizePercent}%`);
      rendition.themes.font(FONT_STACKS[settings.fontFamily]);
      rendition.themes.override("color", color, true);
      rendition.themes.override("background-color", background, true);
      rendition.themes.override("background", background, true);
    } catch {
      // Themes may be unavailable before first render; settings are retained.
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.bumpGeneration();
    this.destroyed = true;
    this.inflightOps = 0;
    this.listeners.clear();
    this.teardownChapter();
    this.detachRendition();
    void this.teardownBook();
    this.revokeOwnedObjectUrls();
    this.location = null;
    this.book = null;
    this.rendition = null;
    this.factory = null;
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private async displayInternal(
    target: string | undefined,
    gen: number,
  ): Promise<void> {
    this.teardownChapter();
    const rendition = this.requireRendition();
    await rendition.display(target);
    if (!this.isCurrent(gen)) return;
    await this.afterChapterSettled(gen);
  }

  private async afterChapterSettled(gen: number): Promise<void> {
    if (!this.isCurrent(gen)) return;

    const doc = readContentsDocument(this.rendition);
    if (doc) {
      this.converter.capture(doc);
      try {
        await this.converter.apply(this.conversion, gen);
      } catch (error) {
        if (!this.isCurrent(gen)) return;
        this.emit({
          type: "conversion-error",
          message: errorMessage(error),
        });
      }
    }

    if (!this.isCurrent(gen)) return;
    this.syncLocationFromRendition();
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
      // Chapter DOM replacement: capture is done in afterChapterSettled.
      // Explicit teardown of previous transform disposers already ran before display.
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
    const owned = this.ownedObjectUrls;
    const hook = (...args: unknown[]): void => {
      const doc = args[0];
      if (!doc || typeof doc !== "object") return;
      const document = doc as Document;
      // Dispose previous chapter transform listeners before replacing chapter.
      if (this.transformResult) {
        try {
          this.transformResult.dispose();
        } catch {
          // ignore
        }
        this.transformResult = null;
      }
      const resolve = createArchiveResolver(book, owned);
      this.transformResult = transformChapter(document, resolve);
    };
    this.spineContentHook = hook;
    book.spine.hooks.content.register(hook);
  }

  private teardownChapter(): void {
    this.converter.destroy();
    if (this.transformResult) {
      try {
        this.transformResult.dispose();
      } catch {
        // ignore
      }
      this.transformResult = null;
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

  private syncLocationFromRendition(): void {
    const rendition = this.rendition;
    if (!rendition) return;

    const raw = rendition.location ?? null;
    if (raw) {
      const mapped = mapLocation(raw, this.spineCount);
      if (mapped) {
        this.location = mapped;
        this.emit({ type: "location", location: mapped });
        return;
      }
    }

    // Some fakes / epub builds expose currentLocation() only.
    const current = rendition.currentLocation?.();
    if (current && typeof (current as Promise<unknown>).then === "function") {
      void (current as Promise<AdaptedLocation | undefined>).then((loc) => {
        if (this.destroyed || !loc) return;
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

function staleError(): Error {
  return new Error("ReaderSession operation superseded");
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
