/**
 * Pure helpers for ReaderSession location transitions.
 * Classifies same-spine vs cross-spine moves without depending on EPUB.js.
 */

/** Minimal location fields used for transition classification. */
export interface LocationLike {
  cfi: string;
  spineHref: string;
  spineIndex: number;
  chapterPage: number;
  chapterPages?: number;
  approximatePercent?: number;
  spineCount?: number;
}

export type TransitionKind =
  | "same-spine-same-document"
  | "same-spine-replaced-document"
  | "cross-spine"
  | "no-transition";

export interface TransitionSnapshot {
  location: LocationLike | null;
  document: Document | null;
  renderEpoch: number;
  cfi: string | undefined;
  spineIndex: number | undefined;
  spineHref: string | undefined;
}

/** True when CFI, page, or spine meaningfully changed. */
export function locationMeaningfullyChanged(
  prev: LocationLike | null | undefined,
  next: LocationLike | null | undefined,
): boolean {
  if (!next) return false;
  if (!prev) return true;
  if (prev.spineIndex !== next.spineIndex) return true;
  if (prev.spineHref && next.spineHref && prev.spineHref !== next.spineHref) {
    return true;
  }
  if (prev.cfi && next.cfi && prev.cfi !== next.cfi) return true;
  if (prev.chapterPage !== next.chapterPage) return true;
  return false;
}

export function classifyTransition(
  before: TransitionSnapshot,
  after: TransitionSnapshot,
): TransitionKind {
  if (!after.location) return "no-transition";
  if (!locationMeaningfullyChanged(before.location, after.location)) {
    // Location unchanged — still may have replaced Document (resize).
    if (
      after.document &&
      before.document &&
      after.document !== before.document
    ) {
      return "same-spine-replaced-document";
    }
    return "no-transition";
  }

  const sameSpine =
    before.location != null &&
    after.location.spineIndex === before.location.spineIndex &&
    (before.location.spineHref === after.location.spineHref ||
      !before.location.spineHref ||
      !after.location.spineHref);

  if (!sameSpine) {
    return "cross-spine";
  }

  if (
    after.document &&
    before.document &&
    after.document !== before.document
  ) {
    return "same-spine-replaced-document";
  }

  return "same-spine-same-document";
}

export function didCrossSpine(
  prevHref: string | undefined,
  prevIndex: number | undefined,
  next: LocationLike | null | undefined,
): boolean {
  if (!next) return false;
  if (prevIndex !== undefined && next.spineIndex !== prevIndex) return true;
  if (prevHref && next.spineHref && prevHref !== next.spineHref) return true;
  return false;
}
