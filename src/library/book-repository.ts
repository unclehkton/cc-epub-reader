import type {
  BookMeta,
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

  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const EPUB_MIME = "application/epub+zip";

async function toStorableEpubBytes(source: Blob): Promise<ArrayBuffer> {
  return source.arrayBuffer();
}

function epubBytesToBlob(value: unknown): Blob | undefined {
  if (typeof Blob !== "undefined" && value instanceof Blob) {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return new Blob([value], { type: EPUB_MIME });
  }
  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView;
    const copy = new ArrayBuffer(view.byteLength);
    new Uint8Array(copy).set(
      new Uint8Array(view.buffer, view.byteOffset, view.byteLength),
    );
    return new Blob([copy], { type: EPUB_MIME });
  }
  if (value !== null && typeof value === "object") {
    const candidate = value as {
      size?: unknown;
      type?: unknown;
      arrayBuffer?: unknown;
      slice?: unknown;
    };
    if (
      typeof candidate.size === "number" &&
      typeof candidate.type === "string" &&
      typeof candidate.arrayBuffer === "function" &&
      typeof candidate.slice === "function"
    ) {
      return candidate as Blob;
    }
  }
  return undefined;
}

interface PersistedMeta {
  id: string;
  fileName: string;
  byteLength: number;
  title: string;
  creator?: string;
  savedAt: number;
  lastOpenedAt?: number;
}

interface PersistedPayload {
  id: string;
  epub: ArrayBuffer;
}

interface PersistedShareRecord {
  id: string;
  fileName: string;
  byteLength: number;
  epub: ArrayBuffer;
  receivedAt: number;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function parseBookMeta(value: unknown): BookMeta | undefined {
  if (value === null || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (
    !isNonEmptyString(record.id) ||
    !isNonEmptyString(record.fileName) ||
    !isFiniteNumber(record.byteLength) ||
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
  const meta: BookMeta = {
    id: record.id,
    fileName: record.fileName,
    byteLength: record.byteLength,
    title: record.title,
    savedAt: record.savedAt,
  };
  if (typeof record.creator === "string") {
    meta.creator = record.creator;
  }
  if (isFiniteNumber(record.lastOpenedAt)) {
    meta.lastOpenedAt = record.lastOpenedAt;
  }
  return meta;
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
  const epub = epubBytesToBlob(record.epub);
  if (
    !isNonEmptyString(record.id) ||
    !isNonEmptyString(record.fileName) ||
    !isFiniteNumber(record.byteLength) ||
    !epub ||
    !isFiniteNumber(record.receivedAt)
  ) {
    return undefined;
  }
  return {
    id: record.id,
    fileName: record.fileName,
    byteLength: record.byteLength,
    epub,
    receivedAt: record.receivedAt,
  };
}

function sortKey(book: BookMeta): number {
  return book.lastOpenedAt ?? book.savedAt;
}

function toPersistedMeta(book: BookMeta): PersistedMeta {
  const meta: PersistedMeta = {
    id: book.id,
    fileName: book.fileName,
    byteLength: book.byteLength,
    title: book.title,
    savedAt: book.savedAt,
  };
  if (book.creator !== undefined) {
    meta.creator = book.creator;
  }
  if (book.lastOpenedAt !== undefined) {
    meta.lastOpenedAt = book.lastOpenedAt;
  }
  return meta;
}

export class BookRepository {
  private async withDb<T>(fn: (db: IDBDatabase) => Promise<T>): Promise<T> {
    const db = await openDatabase();
    try {
      return await fn(db);
    } finally {
      db.close();
    }
  }

  async importBook(input: ValidatedImport): Promise<StoredBook> {
    const epubBytes =
      input.epubBytes ?? (await toStorableEpubBytes(input.epub));
    const epub = new Blob([epubBytes], { type: EPUB_MIME });
    const book: StoredBook = {
      id: createId(),
      fileName: input.fileName,
      byteLength: epubBytes.byteLength,
      epub,
      epubBytes,
      title: input.title,
      savedAt: Date.now(),
    };
    if (input.creator !== undefined) {
      book.creator = input.creator;
    }

    const meta = toPersistedMeta(book);
    const payload: PersistedPayload = { id: book.id, epub: epubBytes };

    await this.withDb(async (db) => {
      const tx = db.transaction(["bookMeta", "bookPayload"], "readwrite");
      const done = transactionDone(tx);
      const putMeta = requestToPromise(tx.objectStore("bookMeta").put(meta));
      const putPayload = requestToPromise(
        tx.objectStore("bookPayload").put(payload),
      );
      await Promise.all([putMeta, putPayload, done]);
    });

    return book;
  }

  /**
   * List library rows without loading EPUB ArrayBuffers into memory.
   */
  async listBooks(): Promise<LibraryBook[]> {
    return this.withDb(async (db) => {
      const tx = db.transaction(["bookMeta", "progress"], "readonly");
      const done = transactionDone(tx);
      const metaReq = requestToPromise(tx.objectStore("bookMeta").getAll());
      const progressReq = requestToPromise(tx.objectStore("progress").getAll());
      const [rawMeta, rawProgress] = await Promise.all([metaReq, progressReq]);
      await done;

      const progressByBookId = new Map<string, StoredProgress>();
      for (const raw of rawProgress) {
        const progress = parseStoredProgress(raw);
        if (progress) {
          progressByBookId.set(progress.bookId, progress);
        }
      }

      const rows: LibraryBook[] = [];
      for (const raw of rawMeta) {
        const book = parseBookMeta(raw);
        if (!book) {
          continue;
        }
        // Guard: metadata rows must not carry payload fields from a bad migration.
        if ("epub" in (raw as object)) {
          // Strip accidental payload if present in the object we return.
          const { epub: _drop, ...rest } = raw as BookMeta & { epub?: unknown };
          void _drop;
          const cleaned = parseBookMeta(rest);
          if (!cleaned) continue;
          const entry: LibraryBook = { book: cleaned };
          const progress = progressByBookId.get(cleaned.id);
          if (progress) entry.progress = progress;
          rows.push(entry);
          continue;
        }
        const entry: LibraryBook = { book };
        const progress = progressByBookId.get(book.id);
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
        const aHasOpened = a.book.lastOpenedAt !== undefined;
        const bHasOpened = b.book.lastOpenedAt !== undefined;
        if (aHasOpened && !bHasOpened) return -1;
        if (!aHasOpened && bHasOpened) return 1;
        return b.book.savedAt - a.book.savedAt;
      });

      return rows;
    });
  }

  async getBook(id: string): Promise<StoredBook | undefined> {
    return this.withDb(async (db) => {
      const readTx = db.transaction(["bookMeta", "bookPayload"], "readonly");
      const readDone = transactionDone(readTx);
      const metaReq = requestToPromise(readTx.objectStore("bookMeta").get(id));
      const payloadReq = requestToPromise(
        readTx.objectStore("bookPayload").get(id),
      );
      const [rawMeta, rawPayload] = await Promise.all([metaReq, payloadReq]);
      await readDone;

      const meta = parseBookMeta(rawMeta);
      if (!meta || meta.id !== id) {
        return undefined;
      }
      const payloadRecord = rawPayload as PersistedPayload | undefined;
      const rawEpub = payloadRecord?.epub;
      const epub = epubBytesToBlob(rawEpub);
      if (!epub) {
        return undefined;
      }
      // Prefer the durable ArrayBuffer identity — ReaderSession.open can skip
      // another full Blob.arrayBuffer() copy for large iPhone warning-range files.
      const epubBytes =
        rawEpub instanceof ArrayBuffer ? rawEpub : undefined;

      // Best-effort lastOpenedAt — never fail open because the stamp write failed
      // (quota / private mode). Payload is already readable.
      meta.lastOpenedAt = Date.now();
      try {
        const writeTx = db.transaction("bookMeta", "readwrite");
        const writeDone = transactionDone(writeTx);
        const put = requestToPromise(
          writeTx.objectStore("bookMeta").put(toPersistedMeta(meta)),
        );
        await Promise.all([put, writeDone]);
      } catch {
        // ignore stamp failure
      }

      return epubBytes
        ? { ...meta, epub, epubBytes }
        : { ...meta, epub };
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
      const tx = db.transaction(
        ["bookMeta", "bookPayload", "progress"],
        "readwrite",
      );
      const done = transactionDone(tx);
      const delMeta = requestToPromise(tx.objectStore("bookMeta").delete(id));
      const delPayload = requestToPromise(
        tx.objectStore("bookPayload").delete(id),
      );
      const delProgress = requestToPromise(
        tx.objectStore("progress").delete(id),
      );
      await Promise.all([delMeta, delPayload, delProgress, done]);
    });
  }

  async stageShare(entry: ShareInboxEntry): Promise<void> {
    const epubBytes = await toStorableEpubBytes(entry.epub);
    const staged: PersistedShareRecord = {
      id: entry.id,
      fileName: entry.fileName,
      byteLength: epubBytes.byteLength,
      epub: epubBytes,
      receivedAt: entry.receivedAt,
    };
    await this.withDb(async (db) => {
      const tx = db.transaction("shareInbox", "readwrite");
      const done = transactionDone(tx);
      const put = requestToPromise(tx.objectStore("shareInbox").put(staged));
      await Promise.all([put, done]);
    });
  }

  async promoteShare(
    id: string,
    validated: ValidatedImport,
  ): Promise<StoredBook> {
    const epubBytes =
      validated.epubBytes ?? (await toStorableEpubBytes(validated.epub));
    const epub = new Blob([epubBytes], { type: EPUB_MIME });
    const book: StoredBook = {
      id: createId(),
      fileName: validated.fileName,
      byteLength: epubBytes.byteLength,
      epub,
      epubBytes,
      title: validated.title,
      savedAt: Date.now(),
    };
    if (validated.creator !== undefined) {
      book.creator = validated.creator;
    }

    const meta = toPersistedMeta(book);
    const payload: PersistedPayload = { id: book.id, epub: epubBytes };

    await this.withDb(async (db) => {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(
          ["shareInbox", "bookMeta", "bookPayload"],
          "readwrite",
        );
        const inboxStore = tx.objectStore("shareInbox");
        const metaStore = tx.objectStore("bookMeta");
        const payloadStore = tx.objectStore("bookPayload");

        let settled = false;
        const fail = (error: unknown) => {
          if (settled) return;
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

        // Existence check only — never materialize the full staged EPUB again
        // (validated.epubBytes already holds the single validated buffer).
        const keyReq =
          typeof inboxStore.getKey === "function"
            ? inboxStore.getKey(id)
            : inboxStore.get(id);
        keyReq.onsuccess = () => {
          const keyResult = keyReq.result;
          const exists =
            keyResult !== undefined &&
            keyResult !== null &&
            (typeof keyResult === "string"
              ? keyResult === id
              : // Legacy get() path returns the full record.
                parseShareInboxEntry(keyResult)?.id === id);
          if (!exists) {
            fail(new Error(`Share inbox entry not found: ${id}`));
            try {
              tx.abort();
            } catch {
              // finishing
            }
            return;
          }
          metaStore.put(meta);
          payloadStore.put(payload);
          inboxStore.delete(id);
        };
        keyReq.onerror = () => {
          fail(keyReq.error ?? new Error("Failed to read share inbox"));
        };
      });
    });

    return book;
  }
}
