/**
 * Thin adapter over EPUB.js so ReaderSession can be unit-tested with fakes
 * that use deferred Promises for open/display/navigation races.
 *
 * Production code loads the pinned `epubjs` package lazily via
 * {@link loadEpubFactory}. Tests inject a custom {@link EpubFactory}.
 */

export interface AdaptedDisplayedLocation {
  index: number;
  href: string;
  cfi: string;
  percentage?: number;
  displayed?: {
    page: number;
    total: number;
  };
}

export interface AdaptedLocation {
  start: AdaptedDisplayedLocation;
  end?: AdaptedDisplayedLocation;
  atStart?: boolean;
  atEnd?: boolean;
}

export interface AdaptedSection {
  href?: string;
  index?: number;
  document?: Document;
  idref?: string;
}

export interface HookLike {
  register(fn: (...args: unknown[]) => unknown): void;
  deregister?(fn: (...args: unknown[]) => unknown): void;
  list?(): Array<(...args: unknown[]) => unknown>;
  trigger?(...args: unknown[]): Promise<unknown>;
  clear?(): void;
}

export interface AdaptedThemes {
  fontSize(size: string): void;
  font(family: string): void;
  override(name: string, value: string, priority?: boolean): void;
  select?(name: string): void;
  default?(theme: object | string): void;
}

export interface AdaptedContents {
  document?: Document;
  content?: Document | Element;
  addStylesheet?: (url: string) => Promise<void>;
}

export interface AdaptedRendition {
  display(target?: string | number): Promise<void>;
  next(): Promise<void>;
  prev(): Promise<void>;
  destroy(): void;
  on(event: string, listener: (...args: unknown[]) => void): void;
  off(event: string, listener: (...args: unknown[]) => void): void;
  flow(flow: string): void;
  resize?(width?: number, height?: number): void;
  clear?(): void;
  location?: AdaptedLocation | null;
  currentLocation?():
    | AdaptedLocation
    | Promise<AdaptedLocation | undefined>
    | undefined;
  getContents?(): AdaptedContents | AdaptedContents[] | undefined;
  themes?: AdaptedThemes;
  hooks: {
    content: HookLike;
    display?: HookLike;
    serialize?: HookLike;
    unloaded?: HookLike;
    render?: HookLike;
    show?: HookLike;
  };
  settings?: {
    allowScriptedContent?: boolean;
    flow?: string;
    spread?: string;
    [key: string]: unknown;
  };
}

export interface AdaptedSpine {
  hooks: {
    content: HookLike;
    serialize?: HookLike;
  };
  length?: number;
  spineItems?: AdaptedSection[];
  get(target?: string | number): AdaptedSection | null | undefined;
  each?(fn: (section: AdaptedSection, index: number) => void): void;
}

export interface AdaptedNavItem {
  label: string;
  href: string;
  subitems?: AdaptedNavItem[];
}

export interface AdaptedBook {
  ready: Promise<unknown>;
  opened?: Promise<unknown>;
  spine: AdaptedSpine;
  navigation?: {
    toc: AdaptedNavItem[];
  };
  packaging?: {
    metadata?: {
      title?: string;
      creator?: string;
    };
  };
  loaded?: {
    metadata?: Promise<{ title?: string; creator?: string }>;
    spine?: Promise<unknown>;
    navigation?: Promise<unknown>;
  };
  renderTo(
    element: Element | string,
    options?: Record<string, unknown>,
  ): AdaptedRendition;
  destroy(): void;
  resolve?(path: string, absolute?: boolean): string;
  archive?: {
    createUrl?(url: string, options?: { base64?: boolean }): Promise<string>;
    urlCache?: Record<string, string>;
    destroy?(): void;
  };
  resources?: {
    urls?: string[];
    replacementUrls?: Array<string | null | undefined>;
    createUrl?(url: string): Promise<string>;
    substitute?(content: string, url?: string): string;
  };
  section?(target: string | number): AdaptedSection | undefined;
  load?(path: string): Promise<unknown>;
}

export interface EpubFactoryOptions {
  /** false = no archive-wide blob/base64 rewrites (preferred). */
  replacements?: string | false;
  openAs?: string;
  encoding?: string;
  [key: string]: unknown;
}

/**
 * Creates an AdaptedBook from local EPUB bytes or a URL.
 * Factories must not touch the network for Blob/ArrayBuffer opens.
 */
export type EpubFactory = (
  source: ArrayBuffer | string,
  options?: EpubFactoryOptions,
) => AdaptedBook;

export interface RenditionCreateOptions {
  width?: number | string;
  height?: number | string;
  flow?: string;
  spread?: string;
  manager?: string;
  allowScriptedContent?: boolean;
  [key: string]: unknown;
}

/** Default rendition options for this product (one spine item, no scripts). */
export const DEFAULT_RENDITION_OPTIONS: RenditionCreateOptions = {
  flow: "paginated",
  spread: "none",
  manager: "default",
  // Never enable EPUB script execution. Image gates are bound from the app
  // after render; hostile content is stripped pre-serialization.
  allowScriptedContent: false,
};

/**
 * Resolve the epubjs factory function across CJS/ESM interop shapes.
 */
export function resolveEpubConstructor(mod: unknown): (
  source?: ArrayBuffer | string | Record<string, unknown>,
  options?: EpubFactoryOptions,
) => AdaptedBook {
  const root = mod as {
    default?: unknown;
    Book?: new (
      source?: ArrayBuffer | string | Record<string, unknown>,
      options?: EpubFactoryOptions,
    ) => AdaptedBook;
  };

  const candidates: unknown[] = [
    root,
    root.default,
    (root.default as { default?: unknown } | undefined)?.default,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "function") {
      return candidate as (
        source?: ArrayBuffer | string | Record<string, unknown>,
        options?: EpubFactoryOptions,
      ) => AdaptedBook;
    }
  }

  if (typeof root.Book === "function") {
    return (source, options) => {
      if (
        source &&
        typeof source === "object" &&
        !(source instanceof ArrayBuffer) &&
        typeof source !== "string"
      ) {
        return new root.Book!(source as Record<string, unknown>);
      }
      const book = new root.Book!(options);
      const openable = book as AdaptedBook & {
        open?: (input: ArrayBuffer | string) => Promise<unknown>;
      };
      if (source !== undefined && typeof openable.open === "function") {
        void openable.open(source as ArrayBuffer | string);
      }
      return book;
    };
  }

  throw new Error("Unable to resolve epubjs constructor from module export");
}

/**
 * Lazy-load the pinned epubjs package and return a factory suitable for
 * opening local ArrayBuffer EPUB bytes.
 */
export async function loadEpubFactory(): Promise<EpubFactory> {
  const mod = await import("epubjs");
  const construct = resolveEpubConstructor(mod);

  return (source: ArrayBuffer | string, options?: EpubFactoryOptions) => {
    // Do not use archive-wide blobUrl replacements — that eagerly materializes
    // object URLs for every package resource. Resolve package paths lazily and
    // create blob URLs only for explicitly revealed chapter assets.
    return construct(source, {
      replacements: options?.replacements ?? false,
      ...options,
    });
  };
}

/**
 * Build a synchronous archive-local URL map from an opened book's resources.
 * Prefer blob/data replacement URLs already produced by EPUB.js; fall back to
 * package-relative hrefs that remain archive-local.
 */
export function buildArchiveUrlMap(book: AdaptedBook): Map<string, string> {
  const map = new Map<string, string>();
  const urls = book.resources?.urls ?? [];
  const replacements = book.resources?.replacementUrls ?? [];

  for (let i = 0; i < urls.length; i += 1) {
    const href = urls[i];
    if (!href) continue;
    const replacement = replacements[i];
    const value =
      typeof replacement === "string" && replacement.trim()
        ? replacement
        : href;
    map.set(href, value);

    // Also index by final path segment for chapter-relative references.
    const slash = href.lastIndexOf("/");
    if (slash >= 0) {
      const base = href.slice(slash + 1);
      if (base && !map.has(base)) {
        map.set(base, value);
      }
      // Common chapter-relative form: images/foo.png when href is OEBPS/images/foo.png
      const imagesIdx = href.indexOf("images/");
      if (imagesIdx >= 0) {
        const rel = href.slice(imagesIdx);
        if (!map.has(rel)) {
          map.set(rel, value);
        }
      }
    }
  }

  return map;
}

/**
 * Create an ArchiveResolver that only returns EPUB archive-local resources.
 * Remote / absolute network URLs never pass through (callers also policy-check).
 */
export function createArchiveResolver(
  book: AdaptedBook,
  ownedObjectUrls?: Set<string>,
): (rawUrl: string) => string | null {
  const map = buildArchiveUrlMap(book);

  return (rawUrl: string): string | null => {
    const trimmed = rawUrl.trim();
    if (!trimmed) return null;

    // Direct map hits.
    const direct = map.get(trimmed);
    if (direct) {
      trackIfBlob(direct, ownedObjectUrls);
      return direct;
    }

    // Strip leading ./ 
    const noDot = trimmed.replace(/^\.\//, "");
    const noDotHit = map.get(noDot);
    if (noDotHit) {
      trackIfBlob(noDotHit, ownedObjectUrls);
      return noDotHit;
    }

    // Resolve via book.resolve when available.
    if (typeof book.resolve === "function") {
      try {
        const resolved = book.resolve(trimmed);
        if (resolved) {
          const byResolved = map.get(resolved);
          if (byResolved) {
            trackIfBlob(byResolved, ownedObjectUrls);
            return byResolved;
          }
          // Match path suffix against known package hrefs.
          for (const [href, value] of map) {
            if (
              resolved.endsWith(href) ||
              href.endsWith(noDot) ||
              resolved.endsWith(noDot)
            ) {
              trackIfBlob(value, ownedObjectUrls);
              return value;
            }
          }
        }
      } catch {
        // ignore resolve failures
      }
    }

    // Suffix / basename matching for relative chapter paths.
    for (const [href, value] of map) {
      if (
        href === noDot ||
        href.endsWith("/" + noDot) ||
        noDot.endsWith("/" + href) ||
        href.endsWith(noDot)
      ) {
        trackIfBlob(value, ownedObjectUrls);
        return value;
      }
    }

    // Archive-local relative path with no network scheme: allow as restorable
    // package path only when it does not escape with a scheme.
    if (
      !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed) &&
      !trimmed.startsWith("//") &&
      !trimmed.includes("\\")
    ) {
      // Only accept if we have some evidence it belongs to the package, or
      // when the book has no resource map yet (empty assets).
      if (map.size === 0) {
        return noDot;
      }
      // Reject unknown paths when we do have a resource inventory — prevents
      // restoring arbitrary strings that are not package assets.
      return null;
    }

    return null;
  };
}

function trackIfBlob(url: string, owned?: Set<string>): void {
  if (!owned) return;
  if (url.startsWith("blob:")) {
    // EPUB.js archive owns most blob URLs; we only track ones we create ourselves.
    // Do not auto-track library-owned blobs (archive.destroy revokes them).
  }
}
