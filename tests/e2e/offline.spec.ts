import { test, expect } from "@playwright/test";
import {
  FIXTURE_READER,
  gotoLibrary,
  importEpub,
  openBook,
  waitForBookTitle,
  waitForServiceWorker,
} from "./helpers";

test.describe("offline", () => {
  test("online first visit precaches; offline reload still serves the app", async ({
    page,
    context,
    browserName,
  }) => {
    await gotoLibrary(page);
    await waitForServiceWorker(page);

    // Import while online so IndexedDB has content for offline resume checks.
    await importEpub(page, FIXTURE_READER);
    await waitForBookTitle(page, "阅读夹具");

    // Give Workbox a moment to finish precache.
    await page.waitForTimeout(1500);

    // Prove the shell is in the Cache Storage API (SW precache).
    const precacheEvidence = await page.evaluate(async () => {
      const keys = await caches.keys();
      let hasIndex = false;
      let hasShellJs = false;
      for (const key of keys) {
        const cache = await caches.open(key);
        const requests = await cache.keys();
        for (const req of requests) {
          const url = req.url;
          if (url.endsWith("/") || url.endsWith("/index.html")) hasIndex = true;
          if (url.includes("/assets/") && url.endsWith(".js")) hasShellJs = true;
        }
      }
      return {
        cacheCount: keys.length,
        hasIndex,
        hasShellJs,
        controlled: Boolean(navigator.serviceWorker.controller),
      };
    });
    expect(precacheEvidence.cacheCount).toBeGreaterThan(0);
    expect(precacheEvidence.hasIndex || precacheEvidence.hasShellJs).toBe(true);

    await context.setOffline(true);

    let navigatedOffline = false;
    try {
      // In-page reload avoids some Playwright WebKit offline navigation bugs.
      await page.evaluate(() => {
        location.reload();
      });
      await page.waitForLoadState("domcontentloaded", { timeout: 30_000 });
      navigatedOffline = true;
    } catch {
      try {
        await page.goto("/", { waitUntil: "domcontentloaded", timeout: 15_000 });
        navigatedOffline = true;
      } catch {
        navigatedOffline = false;
      }
    }

    // Chromium (desktop + mobile) must complete real offline navigation.
    // WebKit on Windows automation may throw internal errors; only then may
    // the suite fall back to precache evidence — never for Chromium projects.
    if (!navigatedOffline) {
      expect(
        browserName === "webkit",
        "Offline navigation must succeed outside known WebKit automation gaps",
      ).toBe(true);
      expect(precacheEvidence.controlled || precacheEvidence.cacheCount > 0).toBe(
        true,
      );
      test.info().annotations.push({
        type: "note",
        description:
          "WebKit offline navigation failed in automation; passed on Cache Storage evidence only",
      });
      await context.setOffline(false);
      return;
    }

    await expect(page.getByRole("heading", { name: "你的書庫" })).toBeVisible({
      timeout: 30_000,
    });
    await expect(
      page.getByRole("button", { name: "開啟 阅读夹具" }),
    ).toBeVisible();

    // Opening the book should still work from IndexedDB + precached chunks.
    await openBook(page, "阅读夹具");
    await expect(page.getByLabel(/閱讀：/)).toBeVisible();

    await context.setOffline(false);
  });
});
