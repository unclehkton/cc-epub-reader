// fake-indexeddb cannot structured-clone jsdom's Blob; use Node's native Blob.
// @vitest-environment node
// @vitest-environment node
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import type {
  ShareInboxEntry,
  StoredProgress,
  ValidatedImport,
} from "../../src/domain/types";
import { BookRepository } from "../../src/library/book-repository";

const DB_NAME = "books-reader";

function makeEpubBlob(label: string): Blob {
  return new Blob([`PK\u0003\u0004-${label}`], { type: "application/epub+zip" });
}

function makeImport(overrides: Partial<ValidatedImport> = {}): ValidatedImport {
  const fileName = overrides.fileName ?? "sample.epub";
  const epub = overrides.epub ?? makeEpubBlob(fileName);
  return {
    title: "Sample Title",
    creator: "Sample Author",
    ...overrides,
    fileName,
    epub,
  };
}

async function deleteDatabase(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error("deleteDatabase failed"));
    request.onblocked = () => resolve();
  });
}

async function countShareInbox(): Promise<number> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB_NAME);
    open.onerror = () => reject(open.error ?? new Error("open failed"));
    open.onsuccess = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains("shareInbox")) {
        db.close();
        resolve(0);
        return;
      }
      const tx = db.transaction("shareInbox", "readonly");
      const countReq = tx.objectStore("shareInbox").count();
      countReq.onsuccess = () => {
        resolve(countReq.result);
        db.close();
      };
      countReq.onerror = () => {
        reject(countReq.error ?? new Error("count failed"));
        db.close();
      };
    };
  });
}

describe("BookRepository", () => {
  let repository: BookRepository;

  beforeEach(async () => {
    await deleteDatabase();
    repository = new BookRepository();
  });

  it("listBooks returns metadata without materializing EPUB payloads", async () => {
    await repository.importBook(
      makeImport({ title: "Payload Book", fileName: "payload.epub" }),
    );
    const listed = await repository.listBooks();
    expect(listed).toHaveLength(1);
    expect(listed[0]!.book.title).toBe("Payload Book");
    expect("epub" in listed[0]!.book).toBe(false);

    const opened = await repository.getBook(listed[0]!.book.id);
    expect(opened?.epub).toBeInstanceOf(Blob);
    expect(opened?.epub.size).toBeGreaterThan(0);
  });

  it("getBook exposes durable ArrayBuffer so open can skip Blob round-trip", async () => {
    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]).buffer;
    const imported = await repository.importBook(
      makeImport({
        title: "Bytes Book",
        fileName: "bytes.epub",
        epub: new Blob([bytes], { type: "application/epub+zip" }),
        epubBytes: bytes,
      }),
    );
    const opened = await repository.getBook(imported.id);
    expect(opened?.epubBytes).toBeInstanceOf(ArrayBuffer);
    expect(opened?.epubBytes?.byteLength).toBe(bytes.byteLength);
    expect(opened?.epub).toBeInstanceOf(Blob);
  });

  it("keeps two imports as distinct library entries", async () => {
    const first = await repository.importBook(
      makeImport({ title: "First Book", fileName: "first.epub" }),
    );
    const second = await repository.importBook(
      makeImport({ title: "Second Book", fileName: "second.epub" }),
    );

    expect(first.id).not.toBe(second.id);

    const listed = await repository.listBooks();
    expect(listed).toHaveLength(2);
    const ids = listed.map((entry) => entry.book.id).sort();
    expect(ids).toEqual([first.id, second.id].sort());
  });

  it("orders library rows by lastOpenedAt then savedAt (both descending)", async () => {
    const older = await repository.importBook(
      makeImport({ title: "Older", fileName: "older.epub" }),
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    const newer = await repository.importBook(
      makeImport({ title: "Newer", fileName: "newer.epub" }),
    );

    let listed = await repository.listBooks();
    expect(listed.map((entry) => entry.book.id)).toEqual([newer.id, older.id]);

    // Opening a book should stamp lastOpenedAt and promote it ahead of newer savedAt-only rows.
    await repository.getBook(older.id);

    listed = await repository.listBooks();
    expect(listed.map((entry) => entry.book.id)).toEqual([older.id, newer.id]);
    expect(listed[0]?.book.lastOpenedAt).toEqual(expect.any(Number));
  });

  it("stores progress per book without cross-contamination", async () => {
    const alpha = await repository.importBook(
      makeImport({ title: "Alpha", fileName: "alpha.epub" }),
    );
    const beta = await repository.importBook(
      makeImport({ title: "Beta", fileName: "beta.epub" }),
    );

    const alphaProgress: StoredProgress = {
      bookId: alpha.id,
      cfi: "epubcfi(/6/4!/4/2/2)",
      spineHref: "chapter1.xhtml",
      approximatePercent: 33,
      updatedAt: Date.now(),
    };
    await repository.saveProgress(alphaProgress);

    const listed = await repository.listBooks();
    const alphaEntry = listed.find((entry) => entry.book.id === alpha.id);
    const betaEntry = listed.find((entry) => entry.book.id === beta.id);

    expect(alphaEntry?.progress).toMatchObject({
      bookId: alpha.id,
      cfi: alphaProgress.cfi,
      approximatePercent: 33,
    });
    expect(betaEntry?.progress).toBeUndefined();
  });

  it("deletes only the selected book and its progress", async () => {
    const keep = await repository.importBook(
      makeImport({ title: "Keep", fileName: "keep.epub" }),
    );
    const remove = await repository.importBook(
      makeImport({ title: "Remove", fileName: "remove.epub" }),
    );

    await repository.saveProgress({
      bookId: keep.id,
      approximatePercent: 10,
      updatedAt: Date.now(),
    });
    await repository.saveProgress({
      bookId: remove.id,
      approximatePercent: 90,
      updatedAt: Date.now(),
    });

    await repository.deleteBook(remove.id);

    const listed = await repository.listBooks();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.book.id).toBe(keep.id);
    expect(listed[0]?.progress?.approximatePercent).toBe(10);

    await expect(repository.getBook(remove.id)).resolves.toBeUndefined();
  });

  it("promotes a share-inbox entry into the library and removes the inbox record", async () => {
    const epub = makeEpubBlob("shared");
    const inboxId = crypto.randomUUID();
    const entry: ShareInboxEntry = {
      id: inboxId,
      fileName: "shared.epub",
      byteLength: epub.size,
      epub,
      receivedAt: Date.now(),
    };

    await repository.stageShare(entry);
    expect(await countShareInbox()).toBe(1);

    const promoted = await repository.promoteShare(
      inboxId,
      makeImport({
        fileName: entry.fileName,
        epub,
        title: "Shared Import",
        creator: "Share Author",
      }),
    );

    expect(promoted.title).toBe("Shared Import");
    expect(await countShareInbox()).toBe(0);

    const listed = await repository.listBooks();
    expect(listed.some((row) => row.book.id === promoted.id)).toBe(true);
  });
});
