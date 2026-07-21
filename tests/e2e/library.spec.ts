import { test, expect } from "@playwright/test";
import {
  FIXTURE_LARGE,
  FIXTURE_READER,
  deleteBook,
  gotoLibrary,
  importEpub,
  waitForBookTitle,
} from "./helpers";

test.describe("library", () => {
  test("imports two books, lists both, and deletes one after confirm", async ({
    page,
  }) => {
    await gotoLibrary(page);

    await importEpub(page, FIXTURE_READER);
    await waitForBookTitle(page, "阅读夹具");
    await expect(page.getByText("1 本書")).toBeVisible();

    await importEpub(page, FIXTURE_LARGE);
    await waitForBookTitle(page, "长章节压力夹具");
    await expect(page.getByText("2 本書")).toBeVisible();

    // Both titles remain listed.
    await expect(
      page.getByRole("button", { name: "開啟 阅读夹具" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "開啟 长章节压力夹具" }),
    ).toBeVisible();

    // Cancel path: open delete dialog then dismiss.
    await page.getByRole("button", { name: "更多：长章节压力夹具" }).click();
    await page.getByRole("menuitem", { name: "刪除" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.getByRole("button", { name: "取消" }).click();
    await expect(
      page.getByRole("button", { name: "開啟 长章节压力夹具" }),
    ).toBeVisible();

    await deleteBook(page, "长章节压力夹具");
    await expect(page.getByText("1 本書")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "開啟 阅读夹具" }),
    ).toBeVisible();
  });
});
