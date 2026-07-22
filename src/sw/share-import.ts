import type { ShareInboxEntry } from "../domain/types";
import { openDatabase, requestToPromise, transactionDone } from "../library/idb";

/** Hard envelope limit for share-target EPUB candidates (100 MiB). */
export const MAX_SHARE_EPUB_BYTES = 100 * 1024 * 1024;

/** Abandoned share-inbox entries expire after 24 hours. */
export const SHARE_INBOX_TTL_MS = 24 * 60 * 60 * 1000;

const SHARE_TARGET_PATH = "/share-target";
const EPUB_FIELD = "epub";

const ACCEPTED_MIME = new Set([
  "application/epub+zip",
  "application/zip",
  "application/x-zip-compressed",
]);

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

function hasEpubExtension(fileName: string): boolean {
  return fileName.toLowerCase().endsWith(".epub");
}

function isAcceptedEpubCandidate(file: File): boolean {
  const mime = (file.type || "").toLowerCase();
  if (mime && ACCEPTED_MIME.has(mime)) {
    return true;
  }
  return hasEpubExtension(file.name || "");
}

function shareTargetPathname(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return "";
  }
}

/** True when this fetch is the OS share-target POST the SW must own. */
export function isShareTargetRequest(request: Request): boolean {
  if (request.method !== "POST") {
    return false;
  }
  return shareTargetPathname(request.url) === SHARE_TARGET_PATH;
}

function localErrorResponse(status: number, message: string): Response {
  const body = `<!DOCTYPE html><html lang="zh-Hant"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/><title>分享匯入失敗</title></head><body><main><h1>無法匯入分享的 EPUB</h1><p>${message}</p><p><a href="/">返回書庫</a>，或使用「匯入 EPUB」。</p></main></body></html>`;
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function redirectToShareImport(request: Request, id: string): Response {
  const location = new URL("/", request.url);
  location.searchParams.set("share-import", id);
  return Response.redirect(location.href, 303);
}

/** Remove shareInbox rows older than the TTL. Returns how many were deleted. */
export async function expireShareInbox(
  now: number = Date.now(),
): Promise<number> {
  const db = await openDatabase();
  try {
    // Prefer the byReceivedAt index + openKeyCursor so we never materialize
    // complete EPUB buffers merely to inspect timestamps.
    const expiredIds: string[] = [];
    await new Promise<void>((resolve, reject) => {
      const readTx = db.transaction("shareInbox", "readonly");
      const store = readTx.objectStore("shareInbox");
      const cutoff = now - SHARE_INBOX_TTL_MS;

      const walkValueCursor = (): void => {
        // Fallback for pre-v3 DBs without the index (should be rare after open).
        const cursorReq = store.openCursor();
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (!cursor) {
            resolve();
            return;
          }
          const entry = cursor.value as { id?: unknown; receivedAt?: unknown };
          if (
            typeof entry.id === "string" &&
            typeof entry.receivedAt === "number" &&
            entry.receivedAt < cutoff
          ) {
            expiredIds.push(entry.id);
          }
          // Advance without retaining the value.
          cursor.continue();
        };
        cursorReq.onerror = () => {
          reject(cursorReq.error ?? new Error("shareInbox cursor failed"));
        };
      };

      if (!store.indexNames.contains("byReceivedAt")) {
        walkValueCursor();
        return;
      }

      const index = store.index("byReceivedAt");
      // Only keys older than the cutoff: IDBKeyRange.upperBound(cutoff, true)
      // excludes the boundary; expired means receivedAt < cutoff.
      const range = IDBKeyRange.upperBound(cutoff, true);
      const keyCursorReq = index.openKeyCursor(range);
      keyCursorReq.onsuccess = () => {
        const cursor = keyCursorReq.result;
        if (!cursor) {
          resolve();
          return;
        }
        const id = cursor.primaryKey;
        if (typeof id === "string") {
          expiredIds.push(id);
        }
        cursor.continue();
      };
      keyCursorReq.onerror = () => {
        reject(keyCursorReq.error ?? new Error("shareInbox key cursor failed"));
      };
    });

    if (expiredIds.length === 0) {
      return 0;
    }

    const writeTx = db.transaction("shareInbox", "readwrite");
    const store = writeTx.objectStore("shareInbox");
    const writeDone = transactionDone(writeTx);
    const deletes = expiredIds.map((id) =>
      requestToPromise(store.delete(id)),
    );
    await Promise.all([...deletes, writeDone]);
    return expiredIds.length;
  } finally {
    db.close();
  }
}

function epubFieldToBlob(value: unknown): Blob | undefined {
  if (typeof Blob !== "undefined" && value instanceof Blob) {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return new Blob([value], { type: "application/epub+zip" });
  }
  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView;
    const copy = new ArrayBuffer(view.byteLength);
    new Uint8Array(copy).set(
      new Uint8Array(view.buffer, view.byteOffset, view.byteLength),
    );
    return new Blob([copy], { type: "application/epub+zip" });
  }
  return undefined;
}

export async function stageShareInbox(entry: ShareInboxEntry): Promise<void> {
  // WebKit cannot structured-clone Blob/File into IndexedDB; store ArrayBuffer.
  const epubBytes = await entry.epub.arrayBuffer();
  const persisted = {
    id: entry.id,
    fileName: entry.fileName,
    byteLength: epubBytes.byteLength,
    epub: epubBytes,
    receivedAt: entry.receivedAt,
  };
  const db = await openDatabase();
  try {
    const tx = db.transaction("shareInbox", "readwrite");
    const done = transactionDone(tx);
    const put = requestToPromise(tx.objectStore("shareInbox").put(persisted));
    await Promise.all([put, done]);
  } finally {
    db.close();
  }
}

export async function getShareInboxEntry(
  id: string,
): Promise<ShareInboxEntry | undefined> {
  const db = await openDatabase();
  try {
    const tx = db.transaction("shareInbox", "readonly");
    const done = transactionDone(tx);
    const value = await requestToPromise(tx.objectStore("shareInbox").get(id));
    await done;
    if (!value || typeof value !== "object") {
      return undefined;
    }
    const record = value as Record<string, unknown>;
    const epub = epubFieldToBlob(record.epub);
    if (
      typeof record.id !== "string" ||
      typeof record.fileName !== "string" ||
      typeof record.byteLength !== "number" ||
      typeof record.receivedAt !== "number" ||
      !epub
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
  } finally {
    db.close();
  }
}

export async function deleteShareInboxEntry(id: string): Promise<void> {
  const db = await openDatabase();
  try {
    const tx = db.transaction("shareInbox", "readwrite");
    const done = transactionDone(tx);
    const del = requestToPromise(tx.objectStore("shareInbox").delete(id));
    await Promise.all([del, done]);
  } finally {
    db.close();
  }
}

/**
 * Local-only share-target handler.
 * Never calls fetch() — the POST body must not reach the network or origin.
 */
export async function handleShareTarget(request: Request): Promise<Response> {
  if (!isShareTargetRequest(request)) {
    return localErrorResponse(405, "只接受分享目標的 POST 請求。");
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return localErrorResponse(400, "無法讀取分享內容。");
  }

  const candidates = formData.getAll(EPUB_FIELD);
  if (candidates.length !== 1) {
    return localErrorResponse(
      400,
      candidates.length === 0
        ? "未找到 EPUB 檔案。"
        : "一次只能分享一個 EPUB 檔案。",
    );
  }

  const candidate = candidates[0];
  // FormDataEntryValue is File | string in DOM lib; reject plain strings.
  if (typeof candidate === "string" || candidate == null) {
    return localErrorResponse(400, "分享內容不是有效的檔案。");
  }

  const blob = candidate as Blob;
  if (typeof blob.size !== "number" || typeof blob.arrayBuffer !== "function") {
    return localErrorResponse(400, "分享內容不是有效的檔案。");
  }

  const fileNameGuess =
    typeof (candidate as File).name === "string" && (candidate as File).name
      ? (candidate as File).name
      : "shared.epub";
  const fileType =
    typeof (candidate as File).type === "string"
      ? (candidate as File).type
      : blob.type || "";

  const file = new File([blob], fileNameGuess, {
    type: fileType || "application/epub+zip",
  });

  if (!isAcceptedEpubCandidate(file)) {
    return localErrorResponse(415, "只接受 EPUB 檔案。");
  }

  if (file.size > MAX_SHARE_EPUB_BYTES) {
    return localErrorResponse(413, "檔案太大，無法匯入。");
  }

  // Best-effort cleanup of abandoned inbox rows before staging a new one.
  try {
    await expireShareInbox();
  } catch {
    // Staging can still proceed if cleanup fails.
  }

  const id = createId();
  const fileName =
    (file.name && file.name.trim()) || "shared.epub";
  const entry: ShareInboxEntry = {
    id,
    fileName,
    byteLength: file.size,
    epub: file,
    receivedAt: Date.now(),
  };

  try {
    await stageShareInbox(entry);
  } catch {
    return localErrorResponse(
      507,
      "無法在此裝置儲存分享的書籍。請改用「匯入 EPUB」。",
    );
  }

  return redirectToShareImport(request, id);
}
