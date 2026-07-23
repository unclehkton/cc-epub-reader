export const DB_NAME = "books-reader";
/**
 * v2 splits book metadata from EPUB payloads so listBooks is memory-safe.
 * v3 adds shareInbox receivedAt index so expiry can walk keys without loading
 * full EPUB buffers.
 */
export const DB_VERSION = 3;

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
    let settled = false;
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onblocked = () => {
      // Another tab holds an older version open; surface as failure so callers retry.
      // If the open later succeeds, onsuccess closes the orphaned connection.
      if (settled) return;
      settled = true;
      reject(new Error("IndexedDB open blocked"));
    };

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
      // Index timestamps so expiry can openKeyCursor without cloning EPUB bytes.
      const shareStore = tx.objectStore("shareInbox");
      if (!shareStore.indexNames.contains("byReceivedAt")) {
        shareStore.createIndex("byReceivedAt", "receivedAt", { unique: false });
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

    request.onsuccess = () => {
      const db = request.result;
      // Close when another connection wants to upgrade (prevents sticky locks).
      db.onversionchange = () => {
        try {
          db.close();
        } catch {
          // ignore
        }
      };
      if (settled) {
        // Late success after onblocked/onerror reject — close orphan.
        try {
          db.close();
        } catch {
          // ignore
        }
        return;
      }
      settled = true;
      resolve(db);
    };
    request.onerror = () => {
      if (settled) return;
      settled = true;
      reject(request.error ?? new Error("Failed to open IndexedDB"));
    };
  });
}

/**
 * Open IndexedDB with a timeout. Late successful opens are closed so they
 * cannot leak connections after the caller has already failed.
 * Clears the timer on success so a resolved open does not leave a dangling
 * timeout that could flip `timedOut` after the fact.
 */
export function openDatabaseWithTimeout(ms: number): Promise<IDBDatabase> {
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const open = openDatabase().then((db) => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (timedOut) {
      try {
        db.close();
      } catch {
        // ignore
      }
      throw new Error("IndexedDB open completed after timeout");
    }
    return db;
  });

  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      timer = undefined;
      reject(new Error("IndexedDB open timed out"));
    }, ms);
  });

  return Promise.race([open, timeout]);
}
