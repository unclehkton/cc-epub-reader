import type { ConversionMode } from "../domain/types";
import {
  loadConverter,
  type ConvertibleMode,
  type OpenCCConverter,
} from "./opencc-profiles";

/** Tags whose descendant text must never be converted. */
const EXCLUDED_TAGS = new Set([
  "SCRIPT",
  "STYLE",
  "CODE",
  "PRE",
  "NOSCRIPT",
  "TEMPLATE",
  "TEXTAREA",
]);

/** SVG metadata element local names (case-insensitive via uppercase). */
const SVG_METADATA_TAGS = new Set(["METADATA", "DESC", "TITLE"]);

const BATCH_YIELD_MS = 200;
const BATCH_SIZE = 32;

/**
 * Chapter-local OpenCC conversion.
 * Captures original text nodes for one active chapter, restores them before
 * every profile apply (never chains), and ignores stale generation results.
 */
export class ChapterConverter {
  private originals = new Map<Text, string>();
  private latestGeneration = -1;
  private root: ParentNode | null = null;

  /**
   * True when this converter already holds an original-text map for `root`.
   * Rebinding the same chapter must not recapture (converted text would become
   * the new “original” and true 原文 could never restore).
   */
  hasCaptureFor(root: ParentNode): boolean {
    return this.root === root && this.originals.size > 0;
  }

  /**
   * Walk `root` and record eligible visible text nodes for later conversion.
   * Replaces any previous capture for this converter instance.
   */
  capture(root: ParentNode): void {
    this.destroy();
    this.root = root;
    const doc = ownerDocument(root);
    if (!doc) {
      return;
    }

    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node: Node): number {
        const text = node as Text;
        if (!isEligibleTextNode(text)) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    let current = walker.nextNode();
    while (current) {
      const text = current as Text;
      this.originals.set(text, text.data);
      current = walker.nextNode();
    }
  }

  /**
   * Restore originals, then apply `mode` for `generation`.
   * Stale generations (superseded after an await) do not mutate the DOM.
   * On conversion failure, originals are restored and the error is rethrown.
   */
  async apply(mode: ConversionMode, generation: number): Promise<void> {
    this.latestGeneration = generation;
    this.restoreOriginals();

    if (mode === "original" || this.originals.size === 0) {
      return;
    }

    try {
      const convert = await loadConverter(mode as ConvertibleMode);
      if (this.isStale(generation)) {
        return;
      }

      const converted = await this.convertAll(convert, generation);
      if (converted === null || this.isStale(generation)) {
        return;
      }

      this.commit(converted);
    } catch (error) {
      this.restoreOriginals();
      throw error;
    }
  }

  /** Drop the chapter-local map and cancel further commits for this instance. */
  destroy(): void {
    this.originals.clear();
    this.root = null;
    // Bump generation so in-flight applies become stale.
    this.latestGeneration = Number.MIN_SAFE_INTEGER;
  }

  private isStale(generation: number): boolean {
    return this.latestGeneration !== generation;
  }

  private restoreOriginals(): void {
    for (const [node, original] of this.originals) {
      if (node.data !== original) {
        node.data = original;
      }
    }
  }

  /**
   * Convert every captured original into a result list without mutating the DOM.
   * If wall time exceeds 200 ms, yield between batches and re-check generation.
   * Returns null when superseded mid-flight.
   */
  private async convertAll(
    convert: OpenCCConverter,
    generation: number,
  ): Promise<Array<[Text, string]> | null> {
    const entries = Array.from(this.originals.entries());
    const results: Array<[Text, string]> = new Array(entries.length);
    const started = now();
    let batchMode = false;

    for (let i = 0; i < entries.length; i++) {
      if (batchMode && i > 0 && i % BATCH_SIZE === 0) {
        await yieldToMain();
        if (this.isStale(generation)) {
          return null;
        }
      }

      const [node, original] = entries[i]!;
      results[i] = [node, convert(original)];

      if (!batchMode && now() - started > BATCH_YIELD_MS) {
        batchMode = true;
      }
    }

    return results;
  }

  private commit(results: Array<[Text, string]>): void {
    for (const [node, text] of results) {
      if (node.data !== text) {
        node.data = text;
      }
    }
  }
}

function ownerDocument(root: ParentNode): Document | null {
  if (root.nodeType === Node.DOCUMENT_NODE) {
    return root as Document;
  }
  return (root as Node).ownerDocument;
}

function isEligibleTextNode(text: Text): boolean {
  const parent = text.parentElement;
  if (!parent) {
    return false;
  }

  if (isExcludedElement(parent) || hasExcludedAncestor(parent)) {
    return false;
  }

  if (!isVisibleElement(parent)) {
    return false;
  }

  return true;
}

function isExcludedElement(el: Element): boolean {
  const tag = el.tagName.toUpperCase();
  if (EXCLUDED_TAGS.has(tag)) {
    return true;
  }
  if (isSvgMetadata(el, tag)) {
    return true;
  }
  return false;
}

function isSvgMetadata(el: Element, tagUpper: string): boolean {
  if (!SVG_METADATA_TAGS.has(tagUpper)) {
    return false;
  }
  // HTML title is a document title, not SVG metadata — only skip SVG namespace.
  const ns = el.namespaceURI ?? "";
  return ns.includes("svg") || tagUpper === "METADATA";
}

function hasExcludedAncestor(el: Element): boolean {
  let current: Element | null = el;
  while (current) {
    if (isExcludedElement(current)) {
      return true;
    }
    current = current.parentElement;
  }
  return false;
}

function isVisibleElement(el: Element): boolean {
  let current: Element | null = el;
  while (current) {
    if (current.hasAttribute("hidden")) {
      return false;
    }
    const htmlEl = current as HTMLElement;
    if (typeof htmlEl.hidden === "boolean" && htmlEl.hidden) {
      return false;
    }

    const inline = htmlEl.style;
    if (inline) {
      if (inline.display === "none" || inline.visibility === "hidden") {
        return false;
      }
    }

    const view = current.ownerDocument?.defaultView;
    if (view) {
      const cs = view.getComputedStyle(current);
      if (cs.display === "none" || cs.visibility === "hidden") {
        return false;
      }
    }

    current = current.parentElement;
  }
  return true;
}

function now(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

function yieldToMain(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof setTimeout === "function") {
      setTimeout(resolve, 0);
    } else {
      resolve();
    }
  });
}
