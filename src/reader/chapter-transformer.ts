/**
 * Pre-serialization chapter transform for EPUB.js `book.spine.hooks.content`.
 *
 * This is the sole security-critical markup mutation path. It runs on the
 * parsed section Document *before* EPUB.js serializes it into the rendition
 * iframe. There is intentionally no post-render fallback sanitizer.
 *
 * Responsibilities:
 * - Strip active/hostile content (script, iframe, handlers, javascript: URLs, …)
 * - Gate archive-local images behind an accessible “點擊顯示圖片” control
 * - Never leave a live network-fetchable image source before reader activation
 */

import {
  type ArchiveResolver,
  resolveArchiveCandidate,
  resolveArchiveSrcset,
  validateRestorableUrl,
} from "./archive-url";
import {
  MAX_AGGREGATE_CSS_BYTES,
  MAX_SINGLE_CSS_BYTES,
  MAX_STYLESHEETS_PER_CHAPTER,
  isPackageStylesheetHref,
  sanitizePackageCss,
} from "./css-sanitize";
import { resolvePackagePath } from "./package-path";

export type { ArchiveResolver };

/** Optional on-demand blob materializer for package-relative data-epub-src values. */
export type MaterializeArchiveUrl = (
  packagePath: string,
) => Promise<string | null>;

export interface ChapterTransformResult {
  dispose(): void;
}

export interface TransformOptions {
  materializeArchiveUrl?: MaterializeArchiveUrl;
  /** Active spine section href for relative package path resolution. */
  sectionHref?: string;
}

/** Cross-realm safe Element cast (iframe nodes fail parent `instanceof`). */
function asElement(value: EventTarget | null | undefined): Element | null {
  if (!value || typeof value !== "object") return null;
  const node = value as Node;
  if (node.nodeType !== 1) return null;
  const el = value as Element;
  if (typeof el.closest !== "function") return null;
  return el;
}

/** Local names removed case-insensitively (HTML + XHTML). */
const REMOVE_LOCAL_NAMES = new Set([
  "script",
  "iframe",
  "object",
  "embed",
  "form",
  "base",
  "applet",
  "frame",
  "frameset",
  "video",
  "audio",
  "source",
  "track",
  "portal",
]);

const SVG_REMOVE_LOCAL_NAMES = new Set([
  "animate",
  "animatetransform",
  "animatemotion",
  "set",
  "foreignobject",
  "use", // can reference external documents
  "handler",
  "script",
]);

const XLINK_NS = "http://www.w3.org/1999/xlink";
const GATE_LABEL = "點擊顯示圖片";

export function transformChapter(
  document: Document,
  resolveArchiveUrl: ArchiveResolver,
  options: TransformOptions = {},
): ChapterTransformResult {
  const disposers: Array<() => void> = [];
  let disposed = false;
  const materialize = options.materializeArchiveUrl;

  stripHostileElements(document);
  stripMetaRefresh(document);
  stripSrcdoc(document);
  stripEventHandlers(document);
  neutralizeJavascriptUrls(document);
  stripRemoteStylesheets(document, resolveArchiveUrl, options.sectionHref);
  sanitizeInlineStyles(document);
  gateImages(document, resolveArchiveUrl, disposers, () => disposed, materialize);
  gateSvgImages(document, resolveArchiveUrl, disposers, () => disposed, materialize);
  stripPictureSources(document);
  stripMediaFetchAttributes(document);
  secureExternalLinks(document);
  // Defense-in-depth: block package scripts even if the iframe sandbox allows
  // scripts so parent-attached image-gate listeners can run (WebKit).
  installChapterContentSecurityPolicy(document);

  return makeDisposable(disposers, () => disposed, (value) => {
    disposed = value;
  });
}

/**
 * Re-attach image gate listeners on the *live* chapter document after EPUB.js
 * serializes the pre-hook document into the rendition iframe (listeners do not
 * survive serialization). Security-critical src stripping still happens only in
 * {@link transformChapter}.
 *
 * Also installs a document-level delegated click handler so WebKit still reveals
 * images when per-button listeners are dropped by iframe document swaps.
 */
export function rebindImageGates(
  document: Document,
  options: TransformOptions = {},
): ChapterTransformResult {
  const disposers: Array<() => void> = [];
  let disposed = false;
  const isDisposed = () => disposed;
  const materialize = options.materializeArchiveUrl;

  const bindButton = (
    button: Element,
    activate: () => void,
  ): void => {
    const onClick = (event: Event): void => {
      event.preventDefault();
      event.stopPropagation();
      if (isDisposed()) return;
      activate();
    };
    // Click only — dual pointerup+click double-materializes on a single tap.
    button.addEventListener("click", onClick);
    disposers.push(() => {
      button.removeEventListener("click", onClick);
    });
  };

  for (const button of Array.from(document.querySelectorAll("button"))) {
    if (!isGateButton(button)) continue;

    // HTML image gate: button immediately before <img data-epub-src>.
    const next = button.nextElementSibling;
    if (next && next.tagName.toLowerCase() === "img") {
      const img = next as HTMLImageElement;
      if (img.getAttribute("data-epub-src") || img.getAttribute("data-epub-srcset")) {
        bindButton(button, () => {
          void revealHtmlImage(img, materialize);
        });
      }
      continue;
    }

    // SVG gate: button immediately before <svg> that hosts a gated <image>.
    if (next && next.tagName.toLowerCase() === "svg") {
      const images = [
        ...Array.from(next.getElementsByTagName("image")),
        ...Array.from(
          next.getElementsByTagNameNS("http://www.w3.org/2000/svg", "image"),
        ),
      ];
      const gated = images.find((el) => el.getAttribute("data-epub-src"));
      if (gated) {
        bindButton(button, () => {
          void revealSvgImage(gated, materialize);
        });
      }
    }
  }

  // Delegated capture-phase handler — survives some iframe reparenting cases and
  // covers WebKit where direct button listeners may not fire from automation.
  const onDocClick = (event: Event): void => {
    if (isDisposed()) return;
    // Cross-realm: do not use parent-realm `instanceof Element`.
    const target = asElement(event.target);
    if (!target) return;
    const button = target.closest("button");
    if (!button || !isGateButton(button)) return;

    const next = button.nextElementSibling;
    if (next && next.tagName.toLowerCase() === "img") {
      const img = next as HTMLImageElement;
      if (img.getAttribute("data-epub-src") || img.getAttribute("data-epub-srcset")) {
        event.preventDefault();
        event.stopPropagation();
        void revealHtmlImage(img, materialize);
      }
      return;
    }
    if (next && next.tagName.toLowerCase() === "svg") {
      const images = [
        ...Array.from(next.getElementsByTagName("image")),
        ...Array.from(
          next.getElementsByTagNameNS("http://www.w3.org/2000/svg", "image"),
        ),
      ];
      const gated = images.find((el) => el.getAttribute("data-epub-src"));
      if (gated) {
        event.preventDefault();
        event.stopPropagation();
        void revealSvgImage(gated, materialize);
      }
    }
  };
  document.addEventListener("click", onDocClick, true);
  disposers.push(() => {
    document.removeEventListener("click", onDocClick, true);
  });

  return makeDisposable(disposers, () => disposed, (value) => {
    disposed = value;
  });
}

function isGateButton(button: Element): boolean {
  const label = button.getAttribute("aria-label") || "";
  const text = button.textContent?.trim() || "";
  return (
    label === GATE_LABEL ||
    text === GATE_LABEL ||
    label.includes("圖片載入失敗") ||
    text.includes("圖片載入失敗")
  );
}

function makeDisposable(
  disposers: Array<() => void>,
  isDisposed: () => boolean,
  setDisposed: (value: boolean) => void,
): ChapterTransformResult {
  return {
    dispose(): void {
      if (isDisposed()) return;
      setDisposed(true);
      for (let i = disposers.length - 1; i >= 0; i -= 1) {
        try {
          disposers[i]!();
        } catch {
          // Best-effort teardown; never throw from dispose.
        }
      }
      disposers.length = 0;
    },
  };
}

/** Collect elements by case-insensitive localName (HTML + XHTML). */
function collectByLocalName(doc: Document, names: Set<string>): Element[] {
  const found: Element[] = [];
  const root = doc.documentElement;
  if (!root) return found;
  const walk = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  let node: Element | null = walk.currentNode as Element;
  while (node) {
    const local = (node.localName || node.tagName || "").toLowerCase();
    if (names.has(local)) found.push(node);
    node = walk.nextNode() as Element | null;
  }
  return found;
}

/**
 * Chapter CSP forbids package scripts while allowing revealed blob images and
 * inline styles. Injected as a meta tag in the chapter document head.
 */
function installChapterContentSecurityPolicy(doc: Document): void {
  // Remove any author CSP first.
  for (const meta of collectByLocalName(doc, new Set(["meta"]))) {
    const httpEquiv = (meta.getAttribute("http-equiv") || "").toLowerCase();
    if (httpEquiv === "content-security-policy") {
      meta.remove();
    }
  }
  const meta = doc.createElement("meta");
  meta.setAttribute("http-equiv", "Content-Security-Policy");
  meta.setAttribute(
    "content",
    [
      "default-src 'none'",
      "script-src 'none'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
      "img-src blob: data:",
      "style-src 'unsafe-inline'",
      "font-src data:",
    ].join("; "),
  );
  const head =
    doc.head ||
    doc.getElementsByTagName("head")[0] ||
    doc.documentElement;
  if (head) {
    head.insertBefore(meta, head.firstChild);
  }
}

function stripHostileElements(doc: Document): void {
  // Walk every element and match by localName (case-insensitive). This catches
  // XHTML `<SCRIPT>`, namespaced SVG active content, and HTML parsers alike —
  // getElementsByTagName("script") can miss case variants in XML documents.
  const toRemove = collectByLocalName(
    doc,
    new Set([...REMOVE_LOCAL_NAMES, ...SVG_REMOVE_LOCAL_NAMES]),
  );
  for (const el of toRemove) {
    el.remove();
  }
}

/** Neutralize network-fetching CSS constructs, including crude escapes. */
function neutralizeCssText(css: string): string {
  let next = css;
  // Strip @import including CSS escapes like @\69 mport
  next = next.replace(/@\\?i\\?m\\?p\\?o\\?r\\?t\b[^;]*;?/gi, "/* stripped import */");
  next = next.replace(/@import\b[^;]*;?/gi, "/* stripped import */");
  // Blank every url(...) except data: / blob: so package/relative/network
  // CSS fetches cannot load images outside the tap-to-reveal gate.
  // Also strip common CSS escapes (e.g. u\rl(...), \75rl) that hide "url".
  next = next.replace(
    /(?:u|\\75|\\0075)\s*(?:r|\\72|\\0072)\s*(?:l|\\6c|\\006c)\s*\(\s*([^)]*)\s*\)/gi,
    (full, inner: string) => {
      const value = String(inner)
        .trim()
        .replace(/^['"]|['"]$/g, "")
        // Unescape simple hex escapes in the URL token for scheme checks.
        .replace(/\\([0-9a-f]{1,6})\s?/gi, (_, hex: string) => {
          try {
            return String.fromCodePoint(Number.parseInt(hex, 16));
          } catch {
            return "";
          }
        })
        .replace(/\\(.)/g, "$1");
      const lower = value.toLowerCase();
      if (lower.startsWith("data:") || lower.startsWith("blob:")) {
        return full;
      }
      return "url(about:blank)";
    },
  );
  return next;
}

/**
 * Neutralize CSS that can fetch remote resources: @import and url(...).
 * Full CSS parsing is out of scope; aggressive string neutralization is used.
 */
function sanitizeInlineStyles(doc: Document): void {
  for (const style of collectByLocalName(doc, new Set(["style"]))) {
    const text = style.textContent ?? "";
    if (!text) continue;
    const next = neutralizeCssText(text);
    if (next !== text) {
      style.textContent = next;
    }
  }

  const root = doc.documentElement;
  if (!root) return;
  const walk = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  let node: Element | null = walk.currentNode as Element;
  while (node) {
    const style = node.getAttribute("style");
    if (style) {
      const next = neutralizeCssText(style);
      if (next !== style) node.setAttribute("style", next);
    }
    node = walk.nextNode() as Element | null;
  }
}

function stripMediaFetchAttributes(doc: Document): void {
  for (const el of collectByLocalName(
    doc,
    new Set(["video", "audio", "source", "track", "embed", "object"]),
  )) {
    el.removeAttribute("src");
    el.removeAttribute("srcset");
    el.removeAttribute("poster");
    el.removeAttribute("data");
  }
}

/**
 * External http(s) and protocol-relative hyperlinks require an explicit
 * opener-safe exit: force new-tab + rel=noopener noreferrer, mark for the
 * parent click bridge (iframe sandbox lacks allow-popups).
 */
function secureExternalLinks(doc: Document): void {
  for (const anchor of collectByLocalName(doc, new Set(["a"]))) {
    const href = anchor.getAttribute("href");
    if (!href) continue;
    const trimmed = href.trim();
    const lower = trimmed.toLowerCase();
    const isProtocolRelative = lower.startsWith("//");
    const isHttp =
      lower.startsWith("http:") ||
      lower.startsWith("https:") ||
      isProtocolRelative;
    if (!isHttp) continue;
    if (isProtocolRelative) {
      // Normalize so parent open() never inherits a page protocol quirk.
      anchor.setAttribute("href", `https:${trimmed}`);
    }
    anchor.setAttribute("target", "_blank");
    anchor.setAttribute("rel", "noopener noreferrer");
    // Parent-side bridge opens via window.open(..., "noopener,noreferrer").
    anchor.setAttribute("data-epub-external", "1");
  }
}

function stripMetaRefresh(doc: Document): void {
  for (const meta of collectByLocalName(doc, new Set(["meta"]))) {
    const httpEquiv = meta.getAttribute("http-equiv");
    if (httpEquiv && httpEquiv.trim().toLowerCase() === "refresh") {
      meta.remove();
    }
  }
}

function stripSrcdoc(doc: Document): void {
  for (const el of Array.from(doc.querySelectorAll("[srcdoc]"))) {
    el.removeAttribute("srcdoc");
  }
}

function stripEventHandlers(doc: Document): void {
  const root: Node = doc.documentElement ?? doc;
  const walk = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  let node = walk.currentNode as Element | null;
  // TreeWalker starts at root; process root then siblings via nextNode.
  while (node) {
    // Copy attributes first — NamedNodeMap is live.
    const attrs = Array.from(node.attributes);
    for (const attr of attrs) {
      if (attr.name.length >= 2 && attr.name.toLowerCase().startsWith("on")) {
        node.removeAttribute(attr.name);
      }
    }
    node = walk.nextNode() as Element | null;
  }
}

function neutralizeJavascriptUrls(doc: Document): void {
  const attrs = ["href", "src", "action", "poster", "cite"] as const;
  const root = doc.documentElement;
  if (!root) return;

  const walk = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  let node: Element | null = walk.currentNode as Element;
  while (node) {
    for (const attr of attrs) {
      const value = node.getAttribute(attr);
      if (value && value.trim().toLowerCase().startsWith("javascript:")) {
        node.removeAttribute(attr);
      }
    }

    const srcset = node.getAttribute("srcset");
    if (srcset && /(?:^|,)\s*javascript:/i.test(srcset)) {
      node.removeAttribute("srcset");
    }

    // Legacy SVG xlink:href (attribute name may appear as xlink:href in HTML).
    const xlinkAttr = node.getAttribute("xlink:href");
    if (xlinkAttr && xlinkAttr.trim().toLowerCase().startsWith("javascript:")) {
      node.removeAttribute("xlink:href");
    }
    if (typeof node.getAttributeNS === "function") {
      const xlink = node.getAttributeNS(XLINK_NS, "href");
      if (xlink && xlink.trim().toLowerCase().startsWith("javascript:")) {
        node.removeAttributeNS(XLINK_NS, "href");
      }
    }

    node = walk.nextNode() as Element | null;
  }
}

function stripRemoteStylesheets(
  doc: Document,
  resolve: ArchiveResolver,
  sectionHref?: string,
): void {
  for (const link of collectByLocalName(doc, new Set(["link"]))) {
    const rel = (link.getAttribute("rel") || "").toLowerCase();
    const href = link.getAttribute("href");
    const isStylesheet = rel.split(/\s+/).includes("stylesheet");
    // Non-stylesheet links (prefetch, icon, alternate, …) must not fetch either.
    if (!isStylesheet) {
      if (href && isRejectedOrNetworkHref(href)) {
        link.remove();
      } else if (href) {
        // Drop networkable link types entirely for untrusted EPUB chrome.
        link.remove();
      }
      continue;
    }

    if (!isPackageStylesheetHref(href)) {
      link.remove();
      continue;
    }

    // Prefer section-relative package path; store for live-document CSS inject.
    const packagePath =
      (sectionHref && href
        ? resolvePackagePath(sectionHref, href)
        : null) || resolveArchiveCandidate(href, resolve);
    if (packagePath == null) {
      link.remove();
    } else {
      // Do not leave a live href (archive-wide replacements are disabled).
      // Live rebind materializes and injects sanitized <style>.
      link.removeAttribute("href");
      link.setAttribute("data-epub-css", packagePath);
    }
  }
}

/**
 * Materialize package stylesheets marked with data-epub-css and inject as
 * sanitized <style> into the live chapter document.
 *
 * Attempted-link budget is applied up front (`slice(0, MAX)`): missing or
 * slow stylesheets still consume a slot so a hostile package cannot queue
 * unbounded materialize/fetch timeouts past the cap.
 */
export async function injectPackageStylesheets(
  doc: Document,
  materialize: MaterializeArchiveUrl,
): Promise<void> {
  const allLinks = Array.from(
    doc.querySelectorAll('link[data-epub-css], link[rel~="stylesheet"]'),
  );
  // Cap attempts, not only successes — drop the tail without awaiting it.
  const links = allLinks.slice(0, MAX_STYLESHEETS_PER_CHAPTER);
  for (const extra of allLinks.slice(MAX_STYLESHEETS_PER_CHAPTER)) {
    extra.remove();
  }

  let aggregate = 0;

  for (const link of links) {
    const path =
      link.getAttribute("data-epub-css") ||
      link.getAttribute("href") ||
      "";
    if (!path || !isPackageStylesheetHref(path)) {
      link.remove();
      continue;
    }
    let url: string | null = null;
    try {
      url = await materialize(path);
    } catch {
      url = null;
    }
    if (!url || (!url.startsWith("blob:") && !url.startsWith("data:"))) {
      link.remove();
      continue;
    }
    let text = "";
    try {
      const res = await fetch(url);
      text = await res.text();
    } catch {
      link.remove();
      continue;
    }
    if (text.length > MAX_SINGLE_CSS_BYTES) {
      link.remove();
      continue;
    }
    aggregate += text.length;
    if (aggregate > MAX_AGGREGATE_CSS_BYTES) {
      link.remove();
      continue;
    }
    const style = doc.createElement("style");
    style.setAttribute("data-epub-injected-css", "1");
    const media = link.getAttribute("media");
    if (media) style.setAttribute("media", media);
    style.textContent = sanitizePackageCss(text);
    link.replaceWith(style);
  }
}

function isRejectedOrNetworkHref(href: string): boolean {
  const lower = href.trim().toLowerCase();
  return (
    lower.startsWith("http:") ||
    lower.startsWith("https:") ||
    lower.startsWith("//") ||
    lower.startsWith("javascript:") ||
    lower.startsWith("/")
  );
}

function gateImages(
  doc: Document,
  resolve: ArchiveResolver,
  disposers: Array<() => void>,
  isDisposed: () => boolean,
  materialize?: MaterializeArchiveUrl,
): void {
  for (const el of collectByLocalName(doc, new Set(["img"]))) {
    const img = el as HTMLImageElement;
    const rawSrc = img.getAttribute("src");
    const rawSrcset = img.getAttribute("srcset");

    // Always strip live fetch attributes first.
    img.removeAttribute("src");
    img.removeAttribute("srcset");

    const safeSrc = resolveArchiveCandidate(rawSrc, resolve);
    const safeSrcset = resolveArchiveSrcset(rawSrcset, resolve);

    if (safeSrc) {
      img.setAttribute("data-epub-src", safeSrc);
    } else {
      img.removeAttribute("data-epub-src");
    }

    if (safeSrcset) {
      img.setAttribute("data-epub-srcset", safeSrcset);
    } else {
      img.removeAttribute("data-epub-srcset");
    }

    if (!safeSrc && !safeSrcset) {
      // Remote / unsafe / unresolvable — leave inert, no gate.
      continue;
    }

    // Ensure unrevealed images still occupy space so parent gates can target them.
    if (!img.getAttribute("width") && !img.style.width) {
      img.style.minWidth = "48px";
    }
    if (!img.getAttribute("height") && !img.style.height) {
      img.style.minHeight = "48px";
    }
    img.style.display = img.style.display || "inline-block";

    installImageGate(doc, img, disposers, isDisposed, materialize);
  }
}

function gateSvgImages(
  doc: Document,
  resolve: ArchiveResolver,
  disposers: Array<() => void>,
  isDisposed: () => boolean,
  materialize?: MaterializeArchiveUrl,
): void {
  const images = [
    ...Array.from(doc.getElementsByTagName("image")),
    ...Array.from(doc.getElementsByTagNameNS("http://www.w3.org/2000/svg", "image")),
  ];
  // Dedupe if both APIs return the same nodes.
  const seen = new Set<Element>();

  for (const image of images) {
    if (seen.has(image)) continue;
    seen.add(image);

    const rawHref =
      image.getAttribute("href") ||
      image.getAttribute("xlink:href") ||
      image.getAttributeNS(XLINK_NS, "href");

    image.removeAttribute("href");
    image.removeAttribute("xlink:href");
    if (typeof image.removeAttributeNS === "function") {
      image.removeAttributeNS(XLINK_NS, "href");
    }

    const safe = resolveArchiveCandidate(rawHref, resolve);
    if (safe) {
      image.setAttribute("data-epub-src", safe);
      installSvgImageGate(doc, image, disposers, isDisposed, materialize);
    } else {
      image.removeAttribute("data-epub-src");
    }
  }
}

function stripPictureSources(doc: Document): void {
  for (const source of Array.from(doc.querySelectorAll("picture source"))) {
    source.removeAttribute("srcset");
    source.removeAttribute("src");
    source.removeAttribute("data-epub-src");
    source.removeAttribute("data-epub-srcset");
  }
}

function installImageGate(
  doc: Document,
  img: HTMLImageElement,
  disposers: Array<() => void>,
  isDisposed: () => boolean,
  materialize?: MaterializeArchiveUrl,
): void {
  const button = doc.createElement("button");
  button.type = "button";
  button.textContent = GATE_LABEL;
  button.setAttribute("aria-label", GATE_LABEL);

  const onClick = (event: Event): void => {
    event.preventDefault();
    event.stopPropagation();
    if (isDisposed()) return;
    void revealHtmlImage(img, materialize);
  };

  button.addEventListener("click", onClick);
  disposers.push(() => {
    button.removeEventListener("click", onClick);
  });

  // Prefer inserting the button immediately before the image for association.
  const parent = img.parentNode;
  if (parent) {
    parent.insertBefore(button, img);
  }
}

function installSvgImageGate(
  doc: Document,
  image: Element,
  disposers: Array<() => void>,
  isDisposed: () => boolean,
  materialize?: MaterializeArchiveUrl,
): void {
  // SVG <image> cannot host a HTML button child reliably in all contexts.
  // Place an HTML button as a previous sibling when the parent allows it;
  // otherwise attach a click listener on a wrapper is not available pre-serialize.
  // Use a foreign-free approach: insert a <button> before the nearest HTML parent
  // or before the svg root's parent.
  const button = doc.createElement("button");
  button.type = "button";
  button.textContent = GATE_LABEL;
  button.setAttribute("aria-label", GATE_LABEL);

  const onClick = (event: Event): void => {
    event.preventDefault();
    event.stopPropagation();
    if (isDisposed()) return;
    void revealSvgImage(image, materialize);
  };

  button.addEventListener("click", onClick);
  disposers.push(() => {
    button.removeEventListener("click", onClick);
  });

  const svg = image.closest("svg");
  const host = svg?.parentNode ?? image.parentNode;
  if (host && svg) {
    host.insertBefore(button, svg);
  } else if (image.parentNode) {
    image.parentNode.insertBefore(button, image);
  }
}

async function revealHtmlImage(
  img: HTMLImageElement,
  materialize?: MaterializeArchiveUrl,
): Promise<void> {
  const storedSrc = validateRestorableUrl(img.getAttribute("data-epub-src"));
  const storedSrcset = img.getAttribute("data-epub-srcset");

  if (storedSrc) {
    let src: string | null = storedSrc.startsWith("blob:") || storedSrc.startsWith("data:")
      ? storedSrc
      : null;
    if (!src && materialize) {
      src = await materialize(storedSrc);
    }
    // Fail closed: never assign an unverified relative/network path.
    if (!src || (!src.startsWith("blob:") && !src.startsWith("data:"))) {
      const button = findAssociatedGateButton(img);
      if (button) {
        button.textContent = "圖片載入失敗，點擊重試";
        button.setAttribute("aria-label", "圖片載入失敗，點擊重試");
      }
      return;
    }
    img.setAttribute("src", src);
  }

  if (storedSrcset) {
    // Re-validate each URL token; only assign verified blob/data URLs.
    const safe = revalidateStoredSrcset(storedSrcset);
    if (safe) {
      const parts = safe.split(",");
      const out: string[] = [];
      for (const part of parts) {
        const trimmed = part.trim();
        const tokens = trimmed.split(/\s+/);
        const url = tokens[0];
        if (!url) continue;
        let resolved: string | null = null;
        if (url.startsWith("blob:") || url.startsWith("data:")) {
          resolved = url;
        } else if (materialize) {
          const m = await materialize(url);
          if (m && (m.startsWith("blob:") || m.startsWith("data:"))) {
            resolved = m;
          }
        }
        // Fail closed: never leave package-relative or network paths in srcset.
        if (!resolved) continue;
        const descriptors = tokens.slice(1).join(" ");
        out.push(descriptors ? `${resolved} ${descriptors}` : resolved);
      }
      if (out.length > 0) {
        img.setAttribute("srcset", out.join(", "));
      } else {
        img.removeAttribute("srcset");
      }
    }
  }

  // Decode failure → retryable error state on the associated button.
  const button = findAssociatedGateButton(img);
  if (button) {
    const onError = (): void => {
      button.textContent = "圖片載入失敗，點擊重試";
      button.setAttribute("aria-label", "圖片載入失敗，點擊重試");
    };
    const onLoad = (): void => {
      button.hidden = true;
    };
    img.addEventListener("error", onError, { once: true });
    img.addEventListener("load", onLoad, { once: true });
    // Reset label for retry clicks.
    button.textContent = GATE_LABEL;
    button.setAttribute("aria-label", GATE_LABEL);
    button.hidden = false;
  }
}

async function revealSvgImage(
  image: Element,
  materialize?: MaterializeArchiveUrl,
): Promise<void> {
  const stored = validateRestorableUrl(image.getAttribute("data-epub-src"));
  if (!stored) return;
  let href: string | null =
    stored.startsWith("blob:") || stored.startsWith("data:") ? stored : null;
  if (!href && materialize) {
    href = await materialize(stored);
  }
  if (!href || (!href.startsWith("blob:") && !href.startsWith("data:"))) {
    return;
  }
  image.setAttribute("href", href);
  try {
    image.setAttributeNS(XLINK_NS, "href", href);
  } catch {
    // ignore namespace failures in non-SVG contexts
  }
}

function revalidateStoredSrcset(stored: string): string | null {
  const parts = stored.split(",");
  const kept: string[] = [];
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const tokens = trimmed.split(/\s+/);
    const url = tokens[0];
    if (!url) continue;
    const safe = validateRestorableUrl(url);
    if (!safe) continue;
    const descriptors = tokens.slice(1).join(" ");
    kept.push(descriptors ? `${safe} ${descriptors}` : safe);
  }
  return kept.length > 0 ? kept.join(", ") : null;
}

function findAssociatedGateButton(img: Element): HTMLButtonElement | null {
  // Exact association only — never `parent.contains(img)` (always true).
  const prev = img.previousElementSibling;
  if (prev && prev.tagName.toLowerCase() === "button") {
    const label = prev.getAttribute("aria-label") || prev.textContent || "";
    if (
      label.includes(GATE_LABEL) ||
      label.includes("圖片載入失敗")
    ) {
      return prev as HTMLButtonElement;
    }
  }
  return null;
}
