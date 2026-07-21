import { test, expect } from "@playwright/test";
import type { Request } from "@playwright/test";
import {
  FIXTURE_READER,
  gotoLibrary,
  importEpub,
  openBook,
  selectTocEntry,
  waitForBookTitle,
} from "./helpers";

function isOutsidePreviewOrigin(url: string, origin: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "data:" || parsed.protocol === "blob:") {
      return false;
    }
    if (parsed.protocol === "about:") {
      return false;
    }
    // Service worker and same-origin assets are fine.
    return parsed.origin !== origin;
  } catch {
    return false;
  }
}

test.describe("privacy", () => {
  test("does not request hosts outside the preview origin while reading fixture", async ({
    page,
    baseURL,
  }) => {
    const origin = new URL(baseURL ?? "http://127.0.0.1:4173").origin;
    const external: string[] = [];

    page.on("request", (request: Request) => {
      const url = request.url();
      if (isOutsidePreviewOrigin(url, origin)) {
        external.push(url);
      }
    });

    await gotoLibrary(page);
    await importEpub(page, FIXTURE_READER);
    await waitForBookTitle(page, "阅读夹具");
    await openBook(page, "阅读夹具");

    // Visit the chapter that embeds a remote https image — it must never load.
    await selectTocEntry(page, /第二章/);
    await page.waitForTimeout(1500);

    // Visit hostile chapter as well.
    await selectTocEntry(page, /第三章/);
    await page.waitForTimeout(1000);

    expect(
      external,
      `Unexpected external requests:\n${external.join("\n")}`,
    ).toEqual([]);
  });

  test("never POSTs EPUB bytes to the HTTP server", async ({ page }) => {
    const epubPosts: string[] = [];

    page.on("request", (request: Request) => {
      if (request.method() !== "POST") return;
      const url = request.url();
      const headers = request.headers();
      const contentType = headers["content-type"] ?? "";
      const resourceType = request.resourceType();
      // Fail if any POST looks like an EPUB upload or share-target hit on network.
      if (
        contentType.includes("epub") ||
        contentType.includes("multipart/form-data") ||
        url.includes("share-target") ||
        resourceType === "other"
      ) {
        // Inspect post data when available.
        const data = request.postDataBuffer();
        if (data && data.length > 4) {
          // ZIP local file header
          if (data[0] === 0x50 && data[1] === 0x4b) {
            epubPosts.push(url);
            return;
          }
        }
        if (url.includes("share-target") || contentType.includes("epub")) {
          epubPosts.push(url);
        }
      }
    });

    await gotoLibrary(page);
    await importEpub(page, FIXTURE_READER);
    await waitForBookTitle(page, "阅读夹具");
    await openBook(page, "阅读夹具");
    await page.waitForTimeout(1000);

    expect(epubPosts, `EPUB POST reached server: ${epubPosts.join(", ")}`).toEqual(
      [],
    );
  });
});
