// fake-indexeddb cannot structured-clone jsdom's Blob; use Node's native Blob.
// @vitest-environment node
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ShareInboxEntry } from "../../src/domain/types";
import {
  expireShareInbox,
  getShareInboxEntry,
  handleShareTarget,
  isShareTargetRequest,
  MAX_SHARE_EPUB_BYTES,
  SHARE_INBOX_TTL_MS,
  stageShareInbox,
} from "../../src/sw/share-import";
import { openDatabase, requestToPromise, transactionDone } from "../../src/library/idb";

const DB_NAME = "books-reader";
const ORIGIN = "https://books.example";

async function deleteDatabase(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () =>
      reject(request.error ?? new Error("deleteDatabase failed"));
    request.onblocked = () => resolve();
  });
}

function makeEpubFile(
  name = "shared.epub",
  options: { type?: string; sizeHint?: number; contents?: string } = {},
): File {
  const type = options.type ?? "application/epub+zip";
  if (options.sizeHint !== undefined) {
    const bytes = new Uint8Array(options.sizeHint);
    bytes[0] = 0x50;
    bytes[1] = 0x4b;
    bytes[2] = 0x03;
    bytes[3] = 0x04;
    return new File([bytes], name, { type });
  }
  const contents = options.contents ?? "PK\u0003\u0004-epub";
  return new File([contents], name, { type });
}

function multipartRequest(
  file: File | null,
  options: {
    method?: string;
    path?: string;
    extraFiles?: File[];
    fieldName?: string;
  } = {},
): Request {
  const method = options.method ?? "POST";
  const path = options.path ?? "/share-target";
  const fieldName = options.fieldName ?? "epub";
  const form = new FormData();
  if (file) {
    form.append(fieldName, file, file.name);
  }
  if (options.extraFiles) {
    for (const extra of options.extraFiles) {
      form.append(fieldName, extra, extra.name);
    }
  }
  return new Request(`${ORIGIN}${path}`, { method, body: form });
}

async function countShareInbox(): Promise<number> {
  const db = await openDatabase();
  try {
    const tx = db.transaction("shareInbox", "readonly");
    const done = transactionDone(tx);
    const keys = await requestToPromise(tx.objectStore("shareInbox").getAllKeys());
    await done;
    return keys.length;
  } finally {
    db.close();
  }
}

beforeEach(async () => {
  await deleteDatabase();
});

describe("isShareTargetRequest", () => {
  it("accepts only POST /share-target", () => {
    expect(
      isShareTargetRequest(
        new Request(`${ORIGIN}/share-target`, { method: "POST", body: new FormData() }),
      ),
    ).toBe(true);
    expect(
      isShareTargetRequest(new Request(`${ORIGIN}/share-target`, { method: "GET" })),
    ).toBe(false);
    expect(
      isShareTargetRequest(
        new Request(`${ORIGIN}/other`, { method: "POST", body: new FormData() }),
      ),
    ).toBe(false);
  });
});

describe("handleShareTarget", () => {
  it("rejects non-share-target methods and paths without calling fetch", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const getRes = await handleShareTarget(
      new Request(`${ORIGIN}/share-target`, { method: "GET" }),
    );
    expect(getRes.status).toBe(405);

    const wrongPath = await handleShareTarget(
      multipartRequest(makeEpubFile(), { path: "/import" }),
    );
    expect(wrongPath.status).toBe(405);

    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("requires exactly one epub field", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const missing = await handleShareTarget(multipartRequest(null));
    expect(missing.status).toBe(400);
    expect(await countShareInbox()).toBe(0);

    const tooMany = await handleShareTarget(
      multipartRequest(makeEpubFile("a.epub"), {
        extraFiles: [makeEpubFile("b.epub")],
      }),
    );
    expect(tooMany.status).toBe(400);
    expect(await countShareInbox()).toBe(0);

    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("rejects wrong type and oversized payloads", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const wrongType = await handleShareTarget(
      multipartRequest(
        makeEpubFile("notes.txt", {
          type: "text/plain",
          contents: "not an epub",
        }),
      ),
    );
    expect(wrongType.status).toBe(415);

    const tooLarge = await handleShareTarget(
      multipartRequest(
        makeEpubFile("huge.epub", { sizeHint: MAX_SHARE_EPUB_BYTES + 1 }),
      ),
    );
    expect(tooLarge.status).toBe(413);
    expect(await countShareInbox()).toBe(0);

    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("stages a valid Blob and redirects locally to /?share-import=<id>", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const file = makeEpubFile("from-share.epub");

    const response = await handleShareTarget(multipartRequest(file));

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(response.status).toBe(303);
    const location = response.headers.get("Location");
    expect(location).toBeTruthy();
    const redirected = new URL(location!);
    expect(redirected.origin).toBe(ORIGIN);
    expect(redirected.pathname).toBe("/");
    const id = redirected.searchParams.get("share-import");
    expect(id).toBeTruthy();

    expect(await countShareInbox()).toBe(1);
    const staged = await getShareInboxEntry(id!);
    expect(staged?.fileName).toBe("from-share.epub");
    expect(staged?.byteLength).toBe(file.size);
    expect(staged?.epub).toBeInstanceOf(Blob);

    fetchSpy.mockRestore();
  });

  it("accepts .epub extension when MIME is empty", async () => {
    const file = makeEpubFile("book.epub", { type: "", contents: "PK\u0003\u0004" });
    const response = await handleShareTarget(multipartRequest(file));
    expect(response.status).toBe(303);
  });

  it("expires staged entries older than 24 hours", async () => {
    const stale: ShareInboxEntry = {
      id: "stale-id",
      fileName: "old.epub",
      byteLength: 4,
      epub: new Blob(["PK\u0003\u0004"], { type: "application/epub+zip" }),
      receivedAt: Date.now() - SHARE_INBOX_TTL_MS - 1,
    };
    const fresh: ShareInboxEntry = {
      id: "fresh-id",
      fileName: "new.epub",
      byteLength: 4,
      epub: new Blob(["PK\u0003\u0004"], { type: "application/epub+zip" }),
      receivedAt: Date.now(),
    };

    await stageShareInbox(stale);
    await stageShareInbox(fresh);
    expect(await countShareInbox()).toBe(2);

    const removed = await expireShareInbox();
    expect(removed).toBe(1);
    expect(await getShareInboxEntry("stale-id")).toBeUndefined();
    expect(await getShareInboxEntry("fresh-id")).toBeTruthy();
  });

  it("expires stale entries as a side effect of a successful share", async () => {
    const stale: ShareInboxEntry = {
      id: "abandoned",
      fileName: "abandoned.epub",
      byteLength: 4,
      epub: new Blob(["PK\u0003\u0004"], { type: "application/epub+zip" }),
      receivedAt: Date.now() - SHARE_INBOX_TTL_MS - 60_000,
    };
    await stageShareInbox(stale);

    const response = await handleShareTarget(
      multipartRequest(makeEpubFile("incoming.epub")),
    );
    expect(response.status).toBe(303);
    expect(await getShareInboxEntry("abandoned")).toBeUndefined();
    expect(await countShareInbox()).toBe(1);
  });
});
