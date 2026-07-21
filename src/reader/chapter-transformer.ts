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

export type { ArchiveResolver };

export interface ChapterTransformResult {
  dispose(): void;
}

const REMOVE_TAGS = [
  "script",
  "iframe",
  "object",
  "embed",
  "form",
  "base",
] as const;

const SVG_REMOVE_TAGS = [
  "animate",
  "animateTransform",
  "animateMotion",
  "set",
  "foreignObject",
] as const;

const XLINK_NS = "http://www.w3.org/1999/xlink";
const GATE_LABEL = "點擊顯示圖片";

export function transformChapter(
  document: Document,
  resolveArchiveUrl: ArchiveResolver,
): ChapterTransformResult {
  const disposers: Array<() => void> = [];
  let disposed = false;

  stripHostileElements(document);
  stripMetaRefresh(document);
  stripSrcdoc(document);
  stripEventHandlers(document);
  neutralizeJavascriptUrls(document);
  stripRemoteStylesheets(document, resolveArchiveUrl);
  gateImages(document, resolveArchiveUrl, disposers, () => disposed);
  gateSvgImages(document, resolveArchiveUrl, disposers, () => disposed);
  stripPictureSources(document);

  return {
    dispose(): void {
      if (disposed) return;
      disposed = true;
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

function stripHostileElements(doc: Document): void {
  for (const tag of REMOVE_TAGS) {
    for (const el of Array.from(doc.getElementsByTagName(tag))) {
      el.remove();
    }
  }
  for (const tag of SVG_REMOVE_TAGS) {
    for (const el of Array.from(doc.getElementsByTagName(tag))) {
      el.remove();
    }
    // SVG elements may be retrieved case-sensitively in XML documents.
    for (const el of Array.from(doc.getElementsByTagNameNS("http://www.w3.org/2000/svg", tag))) {
      el.remove();
    }
  }
}

function stripMetaRefresh(doc: Document): void {
  for (const meta of Array.from(doc.getElementsByTagName("meta"))) {
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

function stripRemoteStylesheets(doc: Document, resolve: ArchiveResolver): void {
  for (const link of Array.from(doc.getElementsByTagName("link"))) {
    const rel = (link.getAttribute("rel") || "").toLowerCase();
    if (!rel.split(/\s+/).includes("stylesheet")) continue;

    const href = link.getAttribute("href");
    const safe = resolveArchiveCandidate(href, resolve);
    if (safe == null) {
      // Remote / rejected / unresolvable stylesheet — remove the link entirely.
      link.remove();
    } else {
      // Keep archive-local stylesheet; rewrite to the resolved form when provided.
      link.setAttribute("href", safe);
    }
  }

  // @import in inline style elements is rare in EPUBs; strip style tags that
  // only exist to pull remote CSS via @import when the body is solely @import remote.
  // Full CSS parsing is out of scope; neutralize style attributes with url(http...).
  for (const el of Array.from(doc.querySelectorAll("[style]"))) {
    const style = el.getAttribute("style");
    if (!style) continue;
    if (/url\s*\(\s*['"]?\s*(https?:|\/\/)/i.test(style)) {
      el.setAttribute(
        "style",
        style.replace(/url\s*\(\s*['"]?\s*(https?:|\/\/)[^)]*\)/gi, "url(about:blank)"),
      );
    }
  }
}

function gateImages(
  doc: Document,
  resolve: ArchiveResolver,
  disposers: Array<() => void>,
  isDisposed: () => boolean,
): void {
  for (const img of Array.from(doc.getElementsByTagName("img"))) {
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

    installImageGate(doc, img, disposers, isDisposed);
  }
}

function gateSvgImages(
  doc: Document,
  resolve: ArchiveResolver,
  disposers: Array<() => void>,
  isDisposed: () => boolean,
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
      installSvgImageGate(doc, image, disposers, isDisposed);
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
): void {
  const button = doc.createElement("button");
  button.type = "button";
  button.textContent = GATE_LABEL;
  button.setAttribute("aria-label", GATE_LABEL);

  const onClick = (event: Event): void => {
    event.preventDefault();
    event.stopPropagation();
    if (isDisposed()) return;
    revealHtmlImage(img);
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
    revealSvgImage(image);
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

function revealHtmlImage(img: HTMLImageElement): void {
  const storedSrc = validateRestorableUrl(img.getAttribute("data-epub-src"));
  const storedSrcset = img.getAttribute("data-epub-srcset");

  if (storedSrc) {
    img.setAttribute("src", storedSrc);
  }

  if (storedSrcset) {
    // Re-validate each URL token in the stored srcset.
    const safe = revalidateStoredSrcset(storedSrcset);
    if (safe) {
      img.setAttribute("srcset", safe);
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

function revealSvgImage(image: Element): void {
  const stored = validateRestorableUrl(image.getAttribute("data-epub-src"));
  if (!stored) return;
  image.setAttribute("href", stored);
  // Some SVG consumers still read xlink:href.
  try {
    image.setAttributeNS(XLINK_NS, "href", stored);
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
  const parent = img.parentElement;
  if (!parent) return null;
  const buttons = parent.querySelectorAll("button");
  for (const button of Array.from(buttons)) {
    if (button.textContent?.includes(GATE_LABEL) || button.getAttribute("aria-label") === GATE_LABEL
      || button.textContent?.includes("圖片載入失敗")) {
      // Prefer a sibling immediately before the image.
      if (button.nextElementSibling === img || parent.contains(img)) {
        return button as HTMLButtonElement;
      }
    }
  }
  // Fallback: previous element sibling.
  const prev = img.previousElementSibling;
  if (prev && prev.tagName.toLowerCase() === "button") {
    return prev as HTMLButtonElement;
  }
  return null;
}
