/**
 * Thin adapter over EPUB.js so ReaderSession can be unit-tested with fakes
 * that use deferred Promises for open/display/navigation races.
 *
 * Production code loads the pinned `epubjs` package lazily via
 * {@link loadEpubFactory}. Tests inject a custom {@link EpubFactory}.
 */

import { MAX_ENTRY_UNCOMPRESSED_BYTES } from "../library/epub-validator";

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
  /**
   * EPUB.js 0.3.93 only disables archive rewrites with the literal `"none"`.
   * Falsy values fall back to `blobUrl` for archived books.
   */
  replacements?: string;
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
  // Never enable package script execution. Image-gate listeners are attached
  // from the embedding app after render (not via EPUB package scripts).
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
    // EPUB.js treats falsy replacements as missing and falls back to blobUrl.
    // The only supported disable value is the string "none".
    const replacements =
      options?.replacements === undefined ? "none" : options.replacements;
    return construct(source, {
      ...options,
      replacements,
    });
  };
}

/**
 * Build a package-path map from an opened book's resource inventory.
 * Values are always package-relative hrefs — never archive-wide blob replacements.
 */
export function buildArchiveUrlMap(book: AdaptedBook): Map<string, string> {
  const map = new Map<string, string>();
  const urls = book.resources?.urls ?? [];

  for (const href of urls) {
    if (!href) continue;
    // Always store the package path itself (chapter-scoped materialization later).
    map.set(href, href);

    const slash = href.lastIndexOf("/");
    if (slash >= 0) {
      const base = href.slice(slash + 1);
      if (base && !map.has(base)) {
        map.set(base, href);
      }
      const imagesIdx = href.indexOf("images/");
      if (imagesIdx >= 0) {
        const rel = href.slice(imagesIdx);
        if (!map.has(rel)) {
          map.set(rel, href);
        }
      }
    }
  }

  return map;
}

/**
 * Create an ArchiveResolver that returns package-local paths only.
 * Blob object URLs are created later on explicit image reveal via
 * {@link materializeArchiveUrl}, not for the whole archive at open.
 */
export function createArchiveResolver(
  book: AdaptedBook,
  _ownedObjectUrls?: Set<string>,
): (rawUrl: string) => string | null {
  const map = buildArchiveUrlMap(book);

  return (rawUrl: string): string | null => {
    const trimmed = rawUrl.trim();
    if (!trimmed) return null;

    const direct = map.get(trimmed);
    if (direct) return direct;

    const noDot = trimmed.replace(/^\.\//, "");
    const noDotHit = map.get(noDot);
    if (noDotHit) return noDotHit;

    if (typeof book.resolve === "function") {
      try {
        const resolved = book.resolve(trimmed);
        if (resolved) {
          const byResolved = map.get(resolved);
          if (byResolved) return byResolved;
          for (const [href, value] of map) {
            if (
              resolved.endsWith(href) ||
              href.endsWith(noDot) ||
              resolved.endsWith(noDot)
            ) {
              return value;
            }
          }
        }
      } catch {
        // ignore resolve failures
      }
    }

    for (const [href, value] of map) {
      if (
        href === noDot ||
        href.endsWith("/" + noDot) ||
        noDot.endsWith("/" + href) ||
        href.endsWith(noDot)
      ) {
        return value;
      }
    }

    if (
      !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed) &&
      !trimmed.startsWith("//") &&
      !trimmed.includes("\\")
    ) {
      if (map.size === 0) {
        return noDot;
      }
      return null;
    }

    return null;
  };
}

/**
 * Create a blob/object URL for one package path when the reader reveals an image.
 * Tracks the URL for later revoke on chapter/session teardown.
 */
export async function materializeArchiveUrl(
  book: AdaptedBook,
  packagePath: string,
  ownedObjectUrls?: Set<string>,
): Promise<string | null> {
  const path = packagePath.trim();
  if (!path) return null;
  if (path.startsWith("blob:") || path.startsWith("data:")) {
    return path;
  }
  if (/^https?:/i.test(path) || path.startsWith("//") || /^javascript:/i.test(path)) {
    return null;
  }

  const rawCandidates = new Set<string>([path]);
  if (typeof book.resolve === "function") {
    try {
      const resolved = book.resolve(path);
      if (resolved) rawCandidates.add(resolved);
    } catch {
      // ignore
    }
  }
  // Common package layouts.
  if (!path.includes("/")) {
    rawCandidates.add(`images/${path}`);
    rawCandidates.add(`OEBPS/images/${path}`);
  } else if (path.startsWith("images/")) {
    rawCandidates.add(`OEBPS/${path}`);
  } else if (!path.startsWith("OEBPS/")) {
    rawCandidates.add(`OEBPS/${path}`);
  }

  // epubjs Archive.getBlob does url.substr(1) — paths must be absolute-from-root
  // with a leading slash (e.g. `/OEBPS/images/local.png`).
  const candidates = new Set<string>();
  for (const c of rawCandidates) {
    const cleaned = c.replace(/^\/+/, "");
    candidates.add(cleaned);
    candidates.add(`/${cleaned}`);
  }

  const create =
    typeof book.archive?.createUrl === "function"
      ? (p: string) => book.archive!.createUrl!(p)
      : typeof book.resources?.createUrl === "function"
        ? (p: string) => book.resources!.createUrl!(p)
        : null;

  if (create) {
    for (const candidate of candidates) {
      try {
        const url = await Promise.race([
          create(candidate),
          new Promise<string>((_, reject) => {
            setTimeout(() => reject(new Error("createUrl timeout")), 4000);
          }),
        ]);
        if (typeof url === "string" && url.trim()) {
          const out = url.trim();
          // Fail closed: only accept verified blob/data object URLs.
          if (!out.startsWith("blob:") && !out.startsWith("data:")) {
            continue;
          }
          // Bound materialised image size (defence against forged ZIP entries).
          if (out.startsWith("blob:") && typeof fetch === "function") {
            try {
              const head = await fetch(out);
              const blob = await head.blob();
              if (blob.size > MAX_ENTRY_UNCOMPRESSED_BYTES) {
                revokeBlobLike(out);
                continue;
              }
            } catch {
              // If we cannot size-check, still return the blob — CSP limits network.
            }
          }
          if (ownedObjectUrls && out.startsWith("blob:")) {
            ownedObjectUrls.add(out);
          }
          return out;
        }
      } catch {
        // try next candidate
      }
    }
  }

  return null;
}

/**
 * Drop revoked blob URLs from EPUB.js archive.urlCache so a later createUrl
 * does not return a dead reference after chapter teardown.
 */
export function purgeArchiveUrlCache(
  book: AdaptedBook,
  urls: Iterable<string>,
): void {
  const cache = book.archive?.urlCache;
  if (!cache || typeof cache !== "object") return;
  const doomed = new Set(urls);
  for (const [key, value] of Object.entries(cache)) {
    if (typeof value === "string" && doomed.has(value)) {
      delete cache[key];
    }
  }
}

type ArchiveBookGuard = AdaptedBook & {
  settings?: { replacements?: string };
  replacements?: () => Promise<unknown>;
  resources?: {
    settings?: { replacements?: string };
    replacementUrls?: Array<string | null | undefined>;
    urls?: string[];
    cssUrls?: string[];
    replacements?: () => Promise<unknown>;
    replaceCss?: (...args: unknown[]) => Promise<unknown>;
    substitute?: (content: string, url?: string) => string;
  };
};

function revokeBlobLike(url: string): void {
  if (!url.startsWith("blob:")) return;
  if (typeof URL === "undefined" || typeof URL.revokeObjectURL !== "function") {
    return;
  }
  try {
    URL.revokeObjectURL(url);
  } catch {
    // ignore
  }
}

/**
 * Install the no-replacement guard *before* `book.ready`.
 *
 * EPUB.js 0.3.93 still *calls* `Book.replacements()` for every archived book
 * even when `settings.replacements === "none"` (book.js: `archived || …`).
 * That path also runs `resources.replaceCss()`, which eagerly blobifies every
 * stylesheet. Patch `book.replacements` immediately so packaging cannot start
 * archive-wide materialization.
 */
export function installNoArchiveReplacementsGuard(book: AdaptedBook): void {
  const anyBook = book as ArchiveBookGuard;

  if (anyBook.settings) {
    anyBook.settings.replacements = "none";
  }

  const armResources = (): void => {
    const resources = anyBook.resources;
    if (!resources) return;
    if (resources.settings) {
      resources.settings.replacements = "none";
    }
    // Neutralize CSS/archive blob creation even if something re-enters later.
    resources.replacements = () => Promise.resolve(resources.urls ?? []);
    resources.replaceCss = () => Promise.resolve([]);
    // substitute with empty replacement map is a no-op identity.
    resources.substitute = (content: string) => content;
  };

  armResources();

  anyBook.replacements = () => {
    armResources();
    return Promise.resolve(anyBook);
  };
}

/**
 * After `book.ready`, re-assert the guard and revoke any blobs that slipped
 * through before the patch (race / partial packaging).
 */
export function enforceNoArchiveReplacements(book: AdaptedBook): void {
  installNoArchiveReplacementsGuard(book);

  const anyBook = book as ArchiveBookGuard;

  const replacements = anyBook.resources?.replacementUrls;
  if (Array.isArray(replacements)) {
    for (const url of replacements) {
      if (typeof url === "string") revokeBlobLike(url);
    }
    anyBook.resources!.replacementUrls = [];
  }

  if (anyBook.archive?.urlCache) {
    for (const [key, value] of Object.entries(anyBook.archive.urlCache)) {
      if (typeof value === "string") {
        revokeBlobLike(value);
        delete anyBook.archive.urlCache[key];
      }
    }
  }
}
