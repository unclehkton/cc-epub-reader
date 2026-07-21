export interface StoredBook {
  id: string;
  fileName: string;
  byteLength: number;
  epub: Blob;
  title: string;
  creator?: string;
  savedAt: number;
  lastOpenedAt?: number;
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
  book: StoredBook;
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
