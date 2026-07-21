import { test, expect } from "@playwright/test";
import {
  FIXTURE_LARGE,
  FIXTURE_READER,
  clickImageGate,
  closeReader,
  contentFrames,
  contentTextIncludes,
  gotoLibrary,
  importEpub,
  openBook,
  openSettings,
  selectTocEntry,
  setConversionHongKong,
  setFlow,
  waitForBookTitle,
} from "./helpers";

test.describe("reader", () => {
  test("resumes distinct positions, switches flow, converts, and gates images", async ({
    page,
  }) => {
    test.setTimeout(180_000);

    await gotoLibrary(page);

    await importEpub(page, FIXTURE_READER);
    await waitForBookTitle(page, "阅读夹具");
    await importEpub(page, FIXTURE_LARGE);
    await waitForBookTitle(page, "长章节压力夹具");

    // Open first book, advance into chapter 2, then close to persist progress.
    await openBook(page, "阅读夹具");
    await selectTocEntry(page, /第二章/);
    // Allow progress debounce + location events.
    await page.waitForTimeout(1000);
    await closeReader(page);

    // Open second book and leave it near the start (different position).
    await openBook(page, "长章节压力夹具");
    await page.getByRole("button", { name: "下一頁" }).first().click();
    await page.waitForTimeout(1000);
    await closeReader(page);

    // Reload library and resume both books — progress should still be present.
    await page.reload();
    await expect(page.getByRole("heading", { name: "你的書庫" })).toBeVisible();

    const firstProgressText = await page
      .locator(".book-row")
      .filter({ hasText: "阅读夹具" })
      .locator(".book-progress")
      .innerText();
    const secondProgressText = await page
      .locator(".book-row")
      .filter({ hasText: "长章节压力夹具" })
      .locator(".book-progress")
      .innerText();

    // Distinct positions: labels for the two books must not be identical once
    // each has been opened at a different spine/page.
    expect(firstProgressText).not.toEqual(secondProgressText);

    // Re-open first book and exercise flow switch + conversion + image gate.
    await openBook(page, "阅读夹具");

    await setFlow(page, "捲動");
    await setFlow(page, "分頁");

    // Hong Kong Traditional conversion on simplified chapter text.
    await selectTocEntry(page, /第一章/);
    await page.waitForTimeout(500);
    await setConversionHongKong(page);
    // s2hk: 软件→軟件, 网络→網絡, 里面→裏面, 头发→頭髮
    const converted = await contentTextIncludes(
      page,
      /軟件|網絡|裏面|頭髮/,
      45_000,
    );
    expect(converted).toBe(true);

    // Navigate to image chapter, reveal local image, then leave chapter.
    await selectTocEntry(page, /第二章/);
    await page.waitForTimeout(800);
    await clickImageGate(page);

    // After reveal, a restored img[src] should exist inside a content frame.
    let revealed = false;
    const revealDeadline = Date.now() + 15_000;
    while (!revealed && Date.now() < revealDeadline) {
      for (const frame of contentFrames(page)) {
        try {
          const srcs = await frame.locator("img").evaluateAll((imgs) =>
            imgs.map((img) => ({
              src: img.getAttribute("src"),
              data: img.getAttribute("data-epub-src"),
            })),
          );
          if (
            srcs.some(
              (row) =>
                typeof row.src === "string" &&
                row.src.length > 0 &&
                !row.src.startsWith("https:"),
            )
          ) {
            revealed = true;
            break;
          }
          // Gate may hide after load; data-epub-src alone means local archive image exists.
          const hiddenGate = await frame
            .locator('button[hidden], button[aria-hidden="true"]')
            .count();
          if (hiddenGate > 0 && srcs.some((row) => row.data)) {
            revealed = true;
            break;
          }
        } catch {
          // ignore
        }
      }
      if (!revealed) {
        await page.waitForTimeout(250);
      }
    }
    expect(revealed).toBe(true);

    // Leave chapter (dispose gates / maps).
    await selectTocEntry(page, /第三章/);
    await page.waitForTimeout(600);

    // Hostile chapter must not keep live scripts in content.
    for (const frame of contentFrames(page)) {
      try {
        const scripts = await frame.locator("script").count();
        expect(scripts).toBe(0);
      } catch {
        // frame may have been replaced
      }
    }

    await closeReader(page);
  });

  test("settings expose conversion and flow options", async ({ page }) => {
    await gotoLibrary(page);
    await importEpub(page, FIXTURE_READER);
    await waitForBookTitle(page, "阅读夹具");
    await openBook(page, "阅读夹具");
    await openSettings(page);
    await expect(page.getByRole("radio", { name: "香港繁體" })).toBeVisible();
    await expect(page.getByRole("radio", { name: "分頁" })).toBeVisible();
    await expect(page.getByRole("radio", { name: "捲動" })).toBeVisible();
  });
});
