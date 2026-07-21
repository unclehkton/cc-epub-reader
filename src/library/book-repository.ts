import type {
  LibraryBook,
  ShareInboxEntry,
  StoredBook,
  StoredProgress,
  ValidatedImport,
} from "../domain/types";
import { openDatabase, requestToPromise, transactionDone } from "./idb";

function createId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  // UUID v4-like fallback for environments without randomUUID (e.g. iOS 15).
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function isBlobLike(value: unknown): value is Blob {
  if (typeof Blob !== "undefined" && value instanceof Blob) {
    return true;
  }
  // Defensive duck-type for structured-clone edge cases.
  if (value === null || typeof value !== "object") {
    return false;
  }
  const candidate = value as {
    size?: unknown;
    type?: unknown;
    arrayBuffer?: unknown;
    slice?: unknown;
  };
  return (
    typeof candidate.size === "number" &&
    typeof candidate.type === "string" &&
    typeof candidate.arrayBuffer === "function" &&
    typeof candidate.slice === "function"
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function parseStoredBook(value: unknown): StoredBook | undefined {
  if (value === null || typeof value !== "object") {
    return undefined;
  }

  const record = value as Record<string, unknown>;

  if (
    !isNonEmptyString(record.id) ||
    !isNonEmptyString(record.fileName) ||
    !isFiniteNumber(record.byteLength) ||
    !isBlobLike(record.epub) ||
    !isNonEmptyString(record.title) ||
    !isFiniteNumber(record.savedAt)
  ) {
    return undefined;
  }

  if (record.creator !== undefined && typeof record.creator !== "string") {
    return undefined;
  }

  if (
    record.lastOpenedAt !== undefined &&
    !isFiniteNumber(record.lastOpenedAt)
  ) {
    return undefined;
  }

  const book: StoredBook = {
    id: record.id,
    fileName: record.fileName,
    byteLength: record.byteLength,
    epub: record.epub,
    title: record.title,
    savedAt: record.savedAt,
  };

  if (typeof record.creator === "string") {
    book.creator = record.creator;
  }
  if (isFiniteNumber(record.lastOpenedAt)) {
    book.lastOpenedAt = record.lastOpenedAt;
  }

  return book;
}

function parseStoredProgress(value: unknown): StoredProgress | undefined {
  if (value === null || typeof value !== "object") {
    return undefined;
  }

  const record = value as Record<string, unknown>;

  if (
    !isNonEmptyString(record.bookId) ||
    !isFiniteNumber(record.approximatePercent) ||
    !isFiniteNumber(record.updatedAt)
  ) {
    return undefined;
  }

  if (record.cfi !== undefined && typeof record.cfi !== "string") {
    return undefined;
  }
  if (record.spineHref !== undefined && typeof record.spineHref !== "string") {
    return undefined;
  }

  const progress: StoredProgress = {
    bookId: record.bookId,
    approximatePercent: record.approximatePercent,
    updatedAt: record.updatedAt,
  };

  if (typeof record.cfi === "string") {
    progress.cfi = record.cfi;
  }
  if (typeof record.spineHref === "string") {
    progress.spineHref = record.spineHref;
  }

  return progress;
}

function parseShareInboxEntry(value: unknown): ShareInboxEntry | undefined {
  if (value === null || typeof value !== "object") {
    return undefined;
  }

  const record = value as Record<string, unknown>;

  if (
    !isNonEmptyString(record.id) ||
    !isNonEmptyString(record.fileName) ||
    !isFiniteNumber(record.byteLength) ||
    !isBlobLike(record.epub) ||
    !isFiniteNumber(record.receivedAt)
  ) {
    return undefined;
  }

  return {
    id: record.id,
    fileName: record.fileName,
    byteLength: record.byteLength,
    epub: record.epub,
    receivedAt: record.receivedAt,
  };
}

/** Sort key: lastOpenedAt when present, otherwise savedAt (descending). */
function sortKey(book: StoredBook): number {
  return book.lastOpenedAt ?? book.savedAt;
}

export class BookRepository {
  /**
   * Open a short-lived connection per operation so callers (and tests) can
   * delete the database without getting stuck on blocked connections.
   */
  private async withDb<T>(fn: (db: IDBDatabase) => Promise<T>): Promise<T> {
    const db = await openDatabase();
    try {
      return await fn(db);
    } finally {
      db.close();
    }
  }

  async importBook(input: ValidatedImport): Promise<StoredBook> {
    const book: StoredBook = {
      id: createId(),
      fileName: input.fileName,
      byteLength: input.epub.size,
      epub: input.epub,
      title: input.title,
      savedAt: Date.now(),
    };
    if (input.creator !== undefined) {
      book.creator = input.creator;
    }

    await this.withDb(async (db) => {
      const tx = db.transaction("books", "readwrite");
      const done = transactionDone(tx);
      const put = requestToPromise(tx.objectStore("books").put(book));
      await Promise.all([put, done]);
    });

    return book;
  }

  async listBooks(): Promise<LibraryBook[]> {
    return this.withDb(async (db) => {
      const tx = db.transaction(["books", "progress"], "readonly");
      const done = transactionDone(tx);
      // Start both requests before any await so the transaction stays alive.
      const booksReq = requestToPromise(tx.objectStore("books").getAll());
      const progressReq = requestToPromise(tx.objectStore("progress").getAll());
      const [rawBooks, rawProgress] = await Promise.all([booksReq, progressReq]);
      await done;

      const progressByBookId = new Map<string, StoredProgress>();
      for (const raw of rawProgress) {
        const progress = parseStoredProgress(raw);
        if (progress) {
          progressByBookId.set(progress.bookId, progress);
        }
      }

      const rows: LibraryBook[] = [];
      for (const raw of rawBooks) {
        const book = parseStoredBook(raw);
        if (!book) {
          // Skip corrupted book records; never delete unrelated rows.
          continue;
        }
        const progress = progressByBookId.get(book.id);
        const entry: LibraryBook = { book };
        if (progress) {
          entry.progress = progress;
        }
        rows.push(entry);
      }

      rows.sort((a, b) => {
        const aKey = sortKey(a.book);
        const bKey = sortKey(b.book);
        if (bKey !== aKey) {
          return bKey - aKey;
        }
        // Equal keys: prefer a row that was opened over a savedAt-only peer.
        const aHasOpened = a.book.lastOpenedAt !== undefined;
        const bHasOpened = b.book.lastOpenedAt !== undefined;
        if (aHasOpened && !bHasOpened) {
          return -1;
        }
        if (!aHasOpened && bHasOpened) {
          return 1;
        }
        return b.book.savedAt - a.book.savedAt;
      });

      return rows;
    });
  }

  async getBook(id: string): Promise<StoredBook | undefined> {
    return this.withDb(async (db) => {
      // Read and write in separate transactions so we never issue a request
      // after an await has deactivated the previous transaction.
      const readTx = db.transaction("books", "readonly");
      const readDone = transactionDone(readTx);
      const raw = await requestToPromise(readTx.objectStore("books").get(id));
      await readDone;

      const book = parseStoredBook(raw);
      if (!book || book.id !== id) {
        // Missing or corrupted: do not mutate or delete other records.
        return undefined;
      }

      book.lastOpenedAt = Date.now();

      const writeTx = db.transaction("books", "readwrite");
      const writeDone = transactionDone(writeTx);
      const put = requestToPromise(writeTx.objectStore("books").put(book));
      await Promise.all([put, writeDone]);
      return book;
    });
  }

  async saveProgress(progress: StoredProgress): Promise<void> {
    await this.withDb(async (db) => {
      const tx = db.transaction("progress", "readwrite");
      const done = transactionDone(tx);
      const put = requestToPromise(tx.objectStore("progress").put(progress));
      await Promise.all([put, done]);
    });
  }

  async deleteBook(id: string): Promise<void> {
    await this.withDb(async (db) => {
      const tx = db.transaction(["books", "progress"], "readwrite");
      const done = transactionDone(tx);
      // Delete only the selected key paths — never a different bookId.
      const delBook = requestToPromise(tx.objectStore("books").delete(id));
      const delProgress = requestToPromise(
        tx.objectStore("progress").delete(id),
      );
      await Promise.all([delBook, delProgress, done]);
    });
  }

  async stageShare(entry: ShareInboxEntry): Promise<void> {
    await this.withDb(async (db) => {
      const tx = db.transaction("shareInbox", "readwrite");
      const done = transactionDone(tx);
      const put = requestToPromise(tx.objectStore("shareInbox").put(entry));
      await Promise.all([put, done]);
    });
  }

  async promoteShare(
    id: string,
    validated: ValidatedImport,
  ): Promise<StoredBook> {
    const book: StoredBook = {
      id: createId(),
      fileName: validated.fileName,
      byteLength: validated.epub.size,
      epub: validated.epub,
      title: validated.title,
      savedAt: Date.now(),
    };
    if (validated.creator !== undefined) {
      book.creator = validated.creator;
    }

    await this.withDb(async (db) => {
      // Multi-step atomic work: chain put/delete inside get onsuccess so the
      // transaction never auto-commits between requests.
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(["shareInbox", "books"], "readwrite");
        const inboxStore = tx.objectStore("shareInbox");
        const booksStore = tx.objectStore("books");

        let settled = false;
        const fail = (error: unknown) => {
          if (settled) {
            return;
          }
          settled = true;
          reject(error instanceof Error ? error : new Error(String(error)));
        };

        tx.oncomplete = () => {
          if (!settled) {
            settled = true;
            resolve();
          }
        };
        tx.onerror = () => {
          fail(tx.error ?? new Error("IndexedDB transaction failed"));
        };
        tx.onabort = () => {
          fail(tx.error ?? new Error("IndexedDB transaction aborted"));
        };

        const getReq = inboxStore.get(id);
        getReq.onsuccess = () => {
          const inbox = parseShareInboxEntry(getReq.result);
          if (!inbox || inbox.id !== id) {
            // Do not delete a different inbox row when validation fails.
            fail(new Error(`Share inbox entry not found: ${id}`));
            try {
              tx.abort();
            } catch {
              // Transaction may already be finishing.
            }
            return;
          }

          // Same readwrite transaction: add book, delete only matching inbox id.
          booksStore.put(book);
          inboxStore.delete(id);
        };
        getReq.onerror = () => {
          fail(getReq.error ?? new Error("Failed to read share inbox"));
        };
      });
    });

    return book;
  }
}
