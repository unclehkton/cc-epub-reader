import { test, expect } from "@playwright/test";
import {
  FIXTURE_READER,
  closeReader,
  gotoLibrary,
  importEpub,
  openBook,
  waitForBookTitle,
} from "./helpers";

test.describe("mobile", () => {
  test("supports portrait and landscape reading chrome", async ({ page }) => {
    // Start in a phone-like portrait viewport (projects may already set this).
    await page.setViewportSize({ width: 390, height: 844 });
    await gotoLibrary(page);
    await importEpub(page, FIXTURE_READER);
    await waitForBookTitle(page, "阅读夹具");
    await openBook(page, "阅读夹具");

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
