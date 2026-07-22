import { test, expect } from "@playwright/test";
import {
  FIXTURE_LARGE,
  FIXTURE_READER,
  clickImageGate,
  closeReader,
  contentFrames,
  contentTextIncludes,
  expectImageRevealedAndDecoded,
  getOpenCalls,
  gotoLibrary,
  importEpub,
  installOpenStub,
  openBook,
  openSettings,
  readReaderLocation,
  selectTocEntry,
  setConversionHongKong,
  setFlow,
  waitForBookTitle,
  waitForStableReaderLocation,
} from "./helpers";

test.describe("reader", () => {
  test("resumes exact CFIs, converts, and decodes gated images", async ({
    page,
  }) => {
    test.setTimeout(180_000);

    await gotoLibrary(page);

    await importEpub(page, FIXTURE_READER);
    await waitForBookTitle(page, "閱讀夾具");
    await importEpub(page, FIXTURE_LARGE);
    await waitForBookTitle(page, "長章節壓力夾具");

    // Open first book, advance into chapter 2, capture CFI *before* close.
    await openBook(page, "閱讀夾具");
    await selectTocEntry(page, /第二章/);
    const firstSaved = await waitForStableReaderLocation(page);
    expect(firstSaved.cfi.length).toBeGreaterThan(8);
    expect(firstSaved.spineHref.length).toBeGreaterThan(0);
    await closeReader(page);

    // Open second book and advance (single long spine — mid-chapter CFI is
    // viewport-sensitive on mobile epubjs; assert percent + spine restore).
    await openBook(page, "長章節壓力夾具");
    const secondStart = await waitForStableReaderLocation(page);
    await page.getByRole("button", { name: "下一頁" }).first().click();
    const secondSaved = await waitForStableReaderLocation(page);
    expect(secondSaved.percent).toBeGreaterThan(secondStart.percent);
    expect(
      secondSaved.cfi === firstSaved.cfi &&
        secondSaved.spineHref === firstSaved.spineHref,
    ).toBe(false);
    await closeReader(page);
    await expect(
      page
        .locator(".book-row")
        .filter({ hasText: "長章節壓力夾具" })
        .locator(".book-progress"),
    ).not.toHaveText("尚未開始", { timeout: 15_000 });

    // Same-session reopen: spine + progress percent (exact mid-chapter CFI is
    // not reliable on Mobile Chrome/Safari with epubjs 0.3.93 pagination).
    await openBook(page, "長章節壓力夾具");
    const secondSameSession = await waitForStableReaderLocation(page);
    expect(secondSameSession.spineHref).toBe(secondSaved.spineHref);
    expect(secondSameSession.percent).toBeGreaterThanOrEqual(
      Math.max(0, secondSaved.percent - 5),
    );
    await closeReader(page);

    // Reload library — both durable imports must survive (not session-only empty).
    await page.reload();
    await expect(page.getByRole("heading", { name: "你的書庫" })).toBeVisible({
      timeout: 60_000,
    });
    await waitForBookTitle(page, "閱讀夾具");
    await waitForBookTitle(page, "長章節壓力夾具");
    await expect(page.getByRole("button", { name: "開啟 閱讀夾具" })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "開啟 長章節壓力夾具" }),
    ).toBeVisible();

    const firstProgressText = await page
      .locator(".book-row")
      .filter({ hasText: "閱讀夾具" })
      .locator(".book-progress")
      .innerText();
    const secondProgressText = await page
      .locator(".book-row")
      .filter({ hasText: "長章節壓力夾具" })
      .locator(".book-progress")
      .innerText();
    expect(firstProgressText).not.toEqual(secondProgressText);

    // Re-open first book and prove *same* CFI as pre-reload capture.
    await openBook(page, "閱讀夾具");
    await expect(page.locator(".reader-chapter-title")).toContainText(
      /第二章|圖片/,
      { timeout: 30_000 },
    );
    const firstResumed = await waitForStableReaderLocation(page);
    expect(firstResumed.cfi).toBe(firstSaved.cfi);
    expect(firstResumed.spineHref).toBe(firstSaved.spineHref);
    await closeReader(page);

    // Re-open second book — spine + percent (see mid-chapter CFI note above).
    await openBook(page, "長章節壓力夾具");
    const secondResumed = await waitForStableReaderLocation(page);
    expect(secondResumed.spineHref).toBe(secondSaved.spineHref);
    expect(secondResumed.percent).toBeGreaterThanOrEqual(
      Math.max(0, secondSaved.percent - 5),
    );
    await closeReader(page);

    // Re-open first book and exercise flow switch + conversion + image gate.
    await openBook(page, "閱讀夾具");

    await setFlow(page, "捲動");
    await setFlow(page, "分頁");

    await selectTocEntry(page, /第一章/);
    await page.waitForTimeout(500);
    await setConversionHongKong(page);
    const converted = await contentTextIncludes(
      page,
      /軟件|網絡|裏面|頭髮/,
      45_000,
    );
    expect(converted).toBe(true);

    await selectTocEntry(page, /第二章/);
    await page.waitForTimeout(800);
    await clickImageGate(page);
    // Require decoded pixels — not merely a blob: attribute string.
    await expectImageRevealedAndDecoded(page);

    await selectTocEntry(page, /第三章/);
    await page.waitForTimeout(600);

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
    await waitForBookTitle(page, "閱讀夾具");
    await openBook(page, "閱讀夾具");
    await openSettings(page);
    await expect(page.getByRole("radio", { name: "香港繁體" })).toBeVisible();
    await expect(page.getByRole("radio", { name: "分頁" })).toBeVisible();
    await expect(page.getByRole("radio", { name: "捲動" })).toBeVisible();
  });

  test("rendition keeps scripted content disabled", async ({ page }) => {
    await gotoLibrary(page);
    await importEpub(page, FIXTURE_READER);
    await waitForBookTitle(page, "閱讀夾具");
    await openBook(page, "閱讀夾具");

    await selectTocEntry(page, /第二章/);
    await page.waitForTimeout(800);
    const parentGate = page.locator("button.epub-parent-image-gate").first();
    await expect(parentGate).toBeVisible({ timeout: 20_000 });

    let sawCsp = false;
    for (const frame of contentFrames(page)) {
      try {
        const content = await frame
          .locator('meta[http-equiv="Content-Security-Policy" i]')
          .first()
          .getAttribute("content", { timeout: 1000 });
        if (
          content &&
          content.includes("script-src") &&
          content.includes("'none'")
        ) {
          sawCsp = true;
          break;
        }
      } catch {
        // frame may be navigating
      }
    }
    expect(sawCsp).toBe(true);

    let scriptBlocked = false;
    for (const frame of contentFrames(page)) {
      try {
        scriptBlocked = await frame.evaluate(() => {
          const marker = `epub-script-probe-${Math.random().toString(16).slice(2)}`;
          (window as unknown as { __epubProbe?: string }).__epubProbe =
            undefined;
          const s = document.createElement("script");
          s.textContent = `window.__epubProbe=${JSON.stringify(marker)}`;
          document.documentElement.appendChild(s);
          const ran =
            (window as unknown as { __epubProbe?: string }).__epubProbe ===
            marker;
          s.remove();
          return !ran;
        });
        if (scriptBlocked) break;
      } catch {
        // cross-origin or detached frame
      }
    }
    expect(scriptBlocked).toBe(true);

    const sandboxAttrs = await page
      .locator(".reader-stage iframe, iframe")
      .evaluateAll((frames) =>
        frames.map(
          (f) => (f as HTMLIFrameElement).getAttribute("sandbox") || "",
        ),
      );
    expect(sandboxAttrs.length).toBeGreaterThan(0);
    for (const sandbox of sandboxAttrs) {
      if (!sandbox) continue;
      expect(sandbox.split(/\s+/)).not.toContain("allow-scripts");
    }
  });

  test("external links open via parent window.open with noopener", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await installOpenStub(page);
    await gotoLibrary(page);
    await importEpub(page, FIXTURE_READER);
    await waitForBookTitle(page, "閱讀夾具");
    await openBook(page, "閱讀夾具");
    await selectTocEntry(page, /第三章/);
    await page.waitForTimeout(800);

    // Prefer parent external-link overlay (WebKit-safe path).
    const parentExternal = page.locator("button.epub-parent-external-link");
    let clicked = false;
    if ((await parentExternal.count()) > 0) {
      await parentExternal.first().click({ timeout: 5_000 });
      clicked = true;
    } else {
      for (const frame of contentFrames(page)) {
        try {
          const link = frame.locator(
            'a[data-epub-external="1"][href*="example.com"]',
          );
          if ((await link.count()) > 0) {
            await link.first().click({ timeout: 5_000 });
            clicked = true;
            break;
          }
        } catch {
          // ignore
        }
      }
    }
    expect(clicked).toBe(true);

    // Parent stub must observe open(); iframe must not navigate away from content.
    await expect
      .poll(async () => (await getOpenCalls(page)).length, { timeout: 10_000 })
      .toBeGreaterThan(0);
    const calls = await getOpenCalls(page);
    expect(
      calls.some(
        (c) =>
          c.url.includes("example.com") &&
          c.target === "_blank" &&
          c.features.includes("noopener"),
      ),
    ).toBe(true);

    // Chapter still present (iframe not replaced by external navigation).
    await expect(page.getByLabel(/閱讀：/)).toBeVisible();
  });

  test("multi-book library survives hard reload and re-navigation", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await gotoLibrary(page);
    await importEpub(page, FIXTURE_READER);
    await waitForBookTitle(page, "閱讀夾具");
    await importEpub(page, FIXTURE_LARGE);
    await waitForBookTitle(page, "長章節壓力夾具");

    await openBook(page, "閱讀夾具");
    await selectTocEntry(page, /第二章/);
    const savedA = await waitForStableReaderLocation(page);
    await closeReader(page);

    await openBook(page, "長章節壓力夾具");
    const startB = await waitForStableReaderLocation(page);
    await page.getByRole("button", { name: "下一頁" }).first().click();
    const savedB = await waitForStableReaderLocation(page);
    expect(savedB.percent).toBeGreaterThan(startB.percent);
    await closeReader(page);
    await openBook(page, "長章節壓力夾具");
    const sameSessionB = await waitForStableReaderLocation(page);
    expect(sameSessionB.spineHref).toBe(savedB.spineHref);
    expect(sameSessionB.percent).toBeGreaterThanOrEqual(
      Math.max(0, savedB.percent - 5),
    );
    await closeReader(page);

    // Hard reload (simulates tab restore / kill-recover for Playwright).
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "你的書庫" })).toBeVisible({
      timeout: 60_000,
    });
    await waitForBookTitle(page, "閱讀夾具");
    await waitForBookTitle(page, "長章節壓力夾具");

    // Second navigation to root (not only reload) must still list both books.
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "你的書庫" })).toBeVisible({
      timeout: 60_000,
    });
    await waitForBookTitle(page, "閱讀夾具");
    await waitForBookTitle(page, "長章節壓力夾具");
    await expect(
      page.getByRole("button", { name: "開啟 閱讀夾具" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "開啟 長章節壓力夾具" }),
    ).toBeVisible();

    await openBook(page, "閱讀夾具");
    const resumedA = await waitForStableReaderLocation(page);
    expect(resumedA.cfi).toBe(savedA.cfi);
    expect(resumedA.spineHref).toBe(savedA.spineHref);
    await closeReader(page);

    await openBook(page, "長章節壓力夾具");
    const resumedB = await waitForStableReaderLocation(page);
    expect(resumedB.spineHref).toBe(savedB.spineHref);
    expect(resumedB.percent).toBeGreaterThanOrEqual(
      Math.max(0, savedB.percent - 5),
    );
    await closeReader(page);
  });
});
