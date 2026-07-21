export const DB_NAME = "books-reader";
/** v2 splits book metadata from EPUB payloads so listBooks is memory-safe. */
export const DB_VERSION = 2;

export type StoreName =
  | "bookMeta"
  | "bookPayload"
  | "progress"
  | "shareInbox"
  | "settings";

export function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

export function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () =>
      reject(tx.error ?? new Error("IndexedDB transaction failed"));
    tx.onabort = () =>
      reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });
}

export function openDatabase(): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = request.result;
      const oldVersion = event.oldVersion;
      const tx = request.transaction;
      if (!tx) {
        return;
      }

      if (!db.objectStoreNames.contains("progress")) {
        db.createObjectStore("progress", { keyPath: "bookId" });
      }
      if (!db.objectStoreNames.contains("shareInbox")) {
        db.createObjectStore("shareInbox", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("settings")) {
        db.createObjectStore("settings", { keyPath: "key" });
      }
      if (!db.objectStoreNames.contains("bookMeta")) {
        db.createObjectStore("bookMeta", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("bookPayload")) {
        db.createObjectStore("bookPayload", { keyPath: "id" });
      }

      // Migrate v1 `books` rows into meta + payload, then drop payloads from list path.
      if (oldVersion < 2 && db.objectStoreNames.contains("books")) {
        const legacy = tx.objectStore("books");
        const meta = tx.objectStore("bookMeta");
        const payload = tx.objectStore("bookPayload");
        const cursorReq = legacy.openCursor();
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (!cursor) {
            return;
          }
          const record = cursor.value as Record<string, unknown>;
          const id = record.id;
          if (typeof id === "string") {
            const metaRow: Record<string, unknown> = {
              id,
              fileName: record.fileName,
              byteLength: record.byteLength,
              title: record.title,
              savedAt: record.savedAt,
            };
            if (typeof record.creator === "string") {
              metaRow.creator = record.creator;
            }
            if (typeof record.lastOpenedAt === "number") {
              metaRow.lastOpenedAt = record.lastOpenedAt;
            }
            meta.put(metaRow);
            if (record.epub !== undefined) {
              payload.put({ id, epub: record.epub });
            }
          }
          cursor.delete();
          cursor.continue();
        };
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("Failed to open IndexedDB"));
  });
}
