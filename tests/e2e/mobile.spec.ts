import { test, expect } from "@playwright/test";
import {
  FIXTURE_MIXED_LAYOUT,
  FIXTURE_READER,
  closeReader,
  contentTextIncludes,
  gotoLibrary,
  importEpub,
  openBook,
  waitForBookTitle,
} from "./helpers";

test.describe("mobile", () => {
  test("keeps long paginated chapters and both page edges inside the phone viewport", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await gotoLibrary(page);
    await importEpub(page, FIXTURE_MIXED_LAYOUT);
    await waitForBookTitle(
      page,
      "這是用來測試手機閱讀器版面不應被書名撐闊的超長書名",
    );
    await openBook(
      page,
      "這是用來測試手機閱讀器版面不應被書名撐闊的超長書名",
    );

    for (let pageTurn = 0; pageTurn < 3; pageTurn += 1) {
      await page
        .getByRole("button", { name: "下一頁" })
        .first()
        .evaluate((element) => (element as HTMLButtonElement).click());
      await page.waitForTimeout(400);
    }

    await expect
      .poll(async () =>
        page.evaluate(() => {
          const stage = document
            .querySelector(".reader-stage")
            ?.getBoundingClientRect();
          const next = document
            .querySelector(".reader-edge--next")
            ?.getBoundingClientRect();
          return {
            viewportWidth: window.innerWidth,
            stageRight: stage?.right ?? Number.POSITIVE_INFINITY,
            nextRight: next?.right ?? Number.POSITIVE_INFINITY,
          };
        }),
      )
      .toEqual({
        viewportWidth: 390,
        stageRight: 390,
        nextRight: 390,
      });

    await page.getByRole("button", { name: "下一頁" }).first().click();
  });

  test("keeps chapter content visible when the window crosses the side-panel breakpoint", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 980, height: 900 });
    await gotoLibrary(page);
    await importEpub(page, FIXTURE_READER);
    await waitForBookTitle(page, "閱讀夾具");
    await openBook(page, "閱讀夾具");

    expect(await contentTextIncludes(page, /第一章 開端/, 15_000)).toBe(true);

    // Real window dragging emits many resize events while EPUB.js is still
    // rebuilding. Exercise the race, not only two settled orientation changes.
    for (let width = 970; width >= 740; width -= 10) {
      await page.setViewportSize({ width, height: 900 });
    }
    for (let width = 750; width <= 980; width += 10) {
      await page.setViewportSize({ width, height: 900 });
    }
    expect(await contentTextIncludes(page, /第一章 開端/, 15_000)).toBe(true);
  });

  test("supports portrait and landscape reading chrome", async ({ page }) => {
    // Start in a phone-like portrait viewport (projects may already set this).
    await page.setViewportSize({ width: 390, height: 844 });
    await gotoLibrary(page);
    await importEpub(page, FIXTURE_READER);
    await waitForBookTitle(page, "閱讀夾具");
    await openBook(page, "閱讀夾具");

    const reader = page.getByLabel(/閱讀：/);
    await expect(reader).toBeVisible();

    // Portrait chrome controls remain reachable (≥44px targets via layout).
    await expect(page.getByRole("button", { name: "下一頁" }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "返回書庫" })).toBeVisible();

    // Rotate to landscape.
    await page.setViewportSize({ width: 844, height: 390 });
    await page.waitForTimeout(500);
    await expect(reader).toBeVisible();
    // Navigation still works after resize/orientation handling.
    await page.getByRole("button", { name: "下一頁" }).first().click();
    await page.waitForTimeout(400);

    // Back to portrait.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(500);
    await expect(reader).toBeVisible();

    await closeReader(page);
    await expect(page.getByRole("heading", { name: "你的書庫" })).toBeVisible();
  });
});
