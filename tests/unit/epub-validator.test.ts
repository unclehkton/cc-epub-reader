import { describe, expect, it } from "vitest";
import { ImportError } from "../../src/library/import-errors";
import { validateEpub } from "../../src/library/epub-validator";
import { makeEpub } from "../helpers/make-epub";

describe("validateEpub", () => {
  it("accepts a well-formed .epub with title and creator", async () => {
    const epub = await makeEpub({
      title: "驗證之書",
      creator: "作者甲",
    });
    const result = await validateEpub(epub, "sample.epub");
    expect(result.title).toBe("驗證之書");
    expect(result.creator).toBe("作者甲");
    expect(result.fileName).toBe("sample.epub");
    expect(result.epub).toBe(epub);
  });

  it("accepts application/epub+zip without relying only on extension", async () => {
    const epub = await makeEpub({ title: "Mime Book" });
    const typed = new Blob([await epub.arrayBuffer()], {
      type: "application/epub+zip",
    });
    const result = await validateEpub(typed, "no-extension");
    expect(result.title).toBe("Mime Book");
  });

  it("rejects missing files", async () => {
    await expect(validateEpub(null as unknown as Blob, "a.epub")).rejects.toMatchObject({
      code: "missing-file",
    });
  });

  it("rejects files over the configurable size ceiling", async () => {
    const epub = await makeEpub({ title: "Big" });
    await expect(
      validateEpub(epub, "big.epub", { maxBytes: 32 }),
    ).rejects.toMatchObject({ code: "too-large" });
  });

  it("rejects archives whose declared entry expansion exceeds the per-entry ceiling", async () => {
    const payload = "x".repeat(4096);
    const bomb = await makeEpub({
      title: "Bomb entry",
      extraFiles: {
        "OEBPS/huge.bin": payload,
      },
    });
    await expect(
      validateEpub(bomb, "bomb.epub", {
        maxEntryUncompressedBytes: 1024,
      }),
    ).rejects.toMatchObject({ code: "too-large" });
  });

  it("rejects archives whose aggregate declared expansion exceeds the total ceiling", async () => {
    const bomb = await makeEpub({
      title: "Aggregate bomb",
      extraFiles: {
        "OEBPS/a.bin": "a".repeat(800),
        "OEBPS/b.bin": "b".repeat(800),
      },
    });
    await expect(
      validateEpub(bomb, "agg.epub", {
        maxEntryUncompressedBytes: 10_000,
        maxTotalUncompressedBytes: 500,
      }),
    ).rejects.toMatchObject({ code: "too-large" });
  });

  it("rejects wrong type when neither extension nor MIME is EPUB", async () => {
    const blob = new Blob([new Uint8Array([0x50, 0x4b, 0x03, 0x04])], {
      type: "application/octet-stream",
    });
    await expect(validateEpub(blob, "notes.txt")).rejects.toMatchObject({
      code: "wrong-type",
    });
  });

  it("rejects non-ZIP payloads as invalid-zip", async () => {
    const blob = new Blob(["not a zip"], { type: "application/epub+zip" });
    await expect(validateEpub(blob, "fake.epub")).rejects.toMatchObject({
      code: "invalid-zip",
    });
  });

  it("rejects missing container rootfile", async () => {
    const epub = await makeEpub({ omitContainer: true, title: "No container" });
    await expect(validateEpub(epub, "missing-container.epub")).rejects.toMatchObject({
      code: "missing-container",
    });
  });

  it("rejects missing package document", async () => {
    const epub = await makeEpub({ omitPackage: true });
    await expect(validateEpub(epub, "missing-package.epub")).rejects.toMatchObject({
      code: "missing-package",
    });
  });

  it("rejects encrypted EPUBs", async () => {
    const epub = await makeEpub({ encrypted: true, title: "Locked" });
    await expect(validateEpub(epub, "drm.epub")).rejects.toMatchObject({
      code: "encrypted",
    });
  });

  it("never embeds raw file bytes in error messages", async () => {
    const secret = "SUPER_SECRET_PAYLOAD_XYZ";
    const blob = new Blob([secret], { type: "application/epub+zip" });
    try {
      await validateEpub(blob, "secret.epub");
      expect.fail("expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(ImportError);
      expect((error as Error).message).not.toContain(secret);
    }
  });
});
