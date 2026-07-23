/** Library list row — never includes the EPUB payload. */
export interface BookMeta {
  id: string;
  fileName: string;
  byteLength: number;
  title: string;
  creator?: string;
  savedAt: number;
  lastOpenedAt?: number;
}

/** Full book with payload, loaded only when opening a reader session. */
export interface StoredBook extends BookMeta {
  epub: Blob;
  /**
   * Preferred single-read bytes from IndexedDB when available.
   * Pass this to ReaderSession.open to avoid Blob→ArrayBuffer doubling.
   */
  epubBytes?: ArrayBuffer;
}

export interface StoredProgress {
  bookId: string;
  cfi?: string;
  spineHref?: string;
  approximatePercent: number;
  updatedAt: number;
}

export interface ShareInboxEntry {
  id: string;
  fileName: string;
  byteLength: number;
  epub: Blob;
  receivedAt: number;
}

export interface ValidatedImport {
  fileName: string;
  epub: Blob;
  title: string;
  creator?: string;
  /**
   * Validated ArrayBuffer from a single full-file read. Prefer this for
   * persistence and open to avoid Blob→ArrayBuffer round trips.
   */
  epubBytes?: ArrayBuffer;
}

export interface LibraryBook {
  /** Metadata only — listBooks must not materialize EPUB bytes. */
  book: BookMeta;
  progress?: StoredProgress;
}

/**
 * Chapter text conversion profiles (OpenCC).
 * - original: no change
 * - traditional / hong-kong / taiwan: Simplified → Traditional
 * - simplified: Traditional → Simplified (t2s)
 */
export type ConversionMode =
  | "original"
  | "traditional"
  | "hong-kong"
  | "taiwan"
  | "simplified";

/** Chrome UI language (library/reader chrome strings). */
export type UiLanguage = "zh-Hant" | "zh-Hans";

export type TocSide = "left" | "right";

export interface StoredSettings {
  key: "reader";
  flow: "paginated" | "scrolled";
  conversion: ConversionMode;
  fontSizePercent: number;
  fontFamily: "book" | "sans" | "system";
  background: "rice" | "white" | "sepia";
  theme: "system" | "day" | "night";
  /** Horizontal page margin as percent of reader stage width (0–20). */
  horizontalMarginPercent?: number;
  /** TOC drawer side when overlay/side panel is shown. */
  tocSide?: TocSide;
  /** App chrome language. */
  uiLanguage?: UiLanguage;
}
