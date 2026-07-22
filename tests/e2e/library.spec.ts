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
    await waitForBookTitle(page, "閱讀夾具");
    await expect(page.getByText("1 本書")).toBeVisible();

    await importEpub(page, FIXTURE_LARGE);
    await waitForBookTitle(page, "長章節壓力夾具");
    await expect(page.getByText("2 本書")).toBeVisible();

    // Both titles remain listed.
    await expect(
      page.getByRole("button", { name: "開啟 閱讀夾具" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "開啟 長章節壓力夾具" }),
    ).toBeVisible();

    // Cancel path: open delete dialog then dismiss.
    await page.getByRole("button", { name: "更多：長章節壓力夾具" }).click();
    await page.getByRole("menuitem", { name: "刪除" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.getByRole("button", { name: "取消" }).click();
    await expect(
      page.getByRole("button", { name: "開啟 長章節壓力夾具" }),
    ).toBeVisible();

    await deleteBook(page, "長章節壓力夾具");
    await expect(page.getByText("1 本書")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "開啟 閱讀夾具" }),
    ).toBeVisible();
  });
});
