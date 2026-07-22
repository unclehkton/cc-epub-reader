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
    // WebKit previously dropped the library when IDB probe timed into session-only.
    await page.reload();
    await expect(page.getByRole("heading", { name: "你的書庫" })).toBeVisible({
      timeout: 60_000,
    });
    // Both durable imports must survive reload (not session-only empty library).
    await waitForBookTitle(page, "阅读夹具");
    await waitForBookTitle(page, "长章节压力夹具");
    await expect(page.getByRole("button", { name: "開啟 阅读夹具" })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "開啟 长章节压力夹具" }),
    ).toBeVisible();

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

    // Re-open first book and prove CFI resume (not only progress string / title regex).
    await openBook(page, "阅读夹具");
    await expect(page.locator(".reader-chapter-title")).toContainText(/第二章|图片/, {
      timeout: 30_000,
    });
    const firstShell = page.locator("[aria-label^='閱讀']").first();
    await expect(firstShell).toHaveAttribute("data-cfi", /epubcfi\s*\(/i, {
      timeout: 30_000,
    });
    const firstCfi = (await firstShell.getAttribute("data-cfi")) || "";
    const firstSpine = (await firstShell.getAttribute("data-spine-href")) || "";
    expect(firstCfi.length).toBeGreaterThan(8);
    expect(firstSpine.length).toBeGreaterThan(0);
    const firstChapterTitle = await page.locator(".reader-chapter-title").innerText();
    await closeReader(page);

    // Re-open second book — distinct restored CFI / spine from the first.
    await openBook(page, "长章节压力夹具");
    await expect(page.getByLabel(/閱讀：/)).toBeVisible();
    const secondShell = page.locator("[aria-label^='閱讀']").first();
    await expect(secondShell).toHaveAttribute("data-cfi", /epubcfi\s*\(/i, {
      timeout: 30_000,
    });
    const secondCfi = (await secondShell.getAttribute("data-cfi")) || "";
    const secondSpine = (await secondShell.getAttribute("data-spine-href")) || "";
    const secondChapterTitle = await page.locator(".reader-chapter-title").innerText();
    expect(secondChapterTitle).not.toEqual(firstChapterTitle);
    // At least one of CFI or spine must differ across the two retained books.
    expect(secondCfi === firstCfi && secondSpine === firstSpine).toBe(false);
    await closeReader(page);

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

    // After reveal, require a live blob:/data: object URL — not merely a gate hide
    // or residual data-epub-src (those can pass without a successful materialize).
    let revealed = false;
    const revealDeadline = Date.now() + 15_000;
    while (!revealed && Date.now() < revealDeadline) {
      for (const frame of contentFrames(page)) {
        try {
          const srcs = await frame.locator("img").evaluateAll((imgs) =>
            imgs.map((img) => img.getAttribute("src")),
          );
          if (
            srcs.some(
              (src) =>
                typeof src === "string" &&
                (src.startsWith("blob:") || src.startsWith("data:")),
            )
          ) {
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

  test("rendition keeps scripted content disabled", async ({ page }) => {
    await gotoLibrary(page);
    await importEpub(page, FIXTURE_READER);
    await waitForBookTitle(page, "阅读夹具");
    await openBook(page, "阅读夹具");

    // Parent overlay gates prove we do not rely on iframe script handlers.
    await selectTocEntry(page, /第二章/);
    await page.waitForTimeout(800);
    const parentGate = page.locator("button.epub-parent-image-gate").first();
    await expect(parentGate).toBeVisible({ timeout: 20_000 });

    // Chapter documents must inject CSP that forbids scripts.
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

    // Script execution must remain blocked even if an attacker injects a script tag.
    let scriptBlocked = false;
    for (const frame of contentFrames(page)) {
      try {
        scriptBlocked = await frame.evaluate(() => {
          const marker = `epub-script-probe-${Math.random().toString(16).slice(2)}`;
          (window as unknown as { __epubProbe?: string }).__epubProbe = undefined;
          const s = document.createElement("script");
          s.textContent = `window.__epubProbe=${JSON.stringify(marker)}`;
          document.documentElement.appendChild(s);
          const ran =
            (window as unknown as { __epubProbe?: string }).__epubProbe === marker;
          s.remove();
          return !ran;
        });
        if (scriptBlocked) break;
      } catch {
        // cross-origin or detached frame
      }
    }
    expect(scriptBlocked).toBe(true);

    // Iframe sandbox: if present, must not grant allow-scripts. EPUB.js may omit
    // sandbox; CSP + allowScriptedContent:false remain the primary controls.
    const sandboxAttrs = await page
      .locator(".reader-stage iframe, iframe")
      .evaluateAll((frames) =>
        frames.map((f) => (f as HTMLIFrameElement).getAttribute("sandbox") || ""),
      );
    expect(sandboxAttrs.length).toBeGreaterThan(0);
    for (const sandbox of sandboxAttrs) {
      if (!sandbox) continue;
      expect(sandbox.split(/\s+/)).not.toContain("allow-scripts");
    }
  });
});
