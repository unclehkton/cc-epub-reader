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
}

export interface LibraryBook {
  /** Metadata only — listBooks must not materialize EPUB bytes. */
  book: BookMeta;
  progress?: StoredProgress;
}

export type ConversionMode = "original" | "traditional" | "hong-kong" | "taiwan";

export interface StoredSettings {
  key: "reader";
  flow: "paginated" | "scrolled";
  conversion: ConversionMode;
  fontSizePercent: number;
  fontFamily: "book" | "sans" | "system";
  background: "rice" | "white" | "sepia";
  theme: "system" | "day" | "night";
}
