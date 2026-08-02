import { test, expect } from "@playwright/test";
import {
  FIXTURE_LARGE,
  FIXTURE_MIXED_LAYOUT,
  FIXTURE_READER,
  bumpFontSize,
  closeReader,
  contentTextIncludes,
  closeSettings,
  gotoLibrary,
  importEpub,
  openBook,
  openSettings,
  readPaginatedStageGeometry,
  readReaderLocation,
  selectTocEntry,
  setFlow,
  waitForBookTitle,
  waitForStableReaderLocation,
} from "./helpers";

test.describe("mobile", () => {
  test("shows uninstalled-phone home-screen guidance without blocking import", async ({
    page,
  }, testInfo) => {
    test.skip(
      !testInfo.project.name.startsWith("Mobile "),
      "Home-screen guidance is intentionally limited to iPhone and Android browsers.",
    );
    await page.setViewportSize({ width: 390, height: 844 });
    await gotoLibrary(page);

    await expect(
      page.getByRole("heading", { name: "將書庫加入主畫面" }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "匯入 EPUB" })).toBeVisible();
    await expect(page.getByRole("button", { name: "關閉安裝提示" })).toBeVisible();

    const userAgent = await page.evaluate(() => navigator.userAgent);
    if (/iphone|ipod/i.test(userAgent)) {
      await expect(page.getByText(/Safari 分享按鈕/)).toBeVisible();
    } else {
      await expect(page.getByText(/Chrome.*選單/)).toBeVisible();
    }
  });

  test("hides home-screen guidance in standalone display mode", async ({ page }) => {
    await page.addInitScript(() => {
      const originalMatchMedia = window.matchMedia.bind(window);
      window.matchMedia = (query: string) => {
        if (query === "(display-mode: standalone)") {
          return {
            matches: true,
            media: query,
            onchange: null,
            addEventListener: () => undefined,
            removeEventListener: () => undefined,
            addListener: () => undefined,
            removeListener: () => undefined,
            dispatchEvent: () => false,
          } as MediaQueryList;
        }
        return originalMatchMedia(query);
      };
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await gotoLibrary(page);
    await expect(
      page.getByRole("heading", { name: "將書庫加入主畫面" }),
    ).toBeHidden();
  });

  test("keeps the image display gate above the page navigation bar", async ({
    page,
  }, testInfo) => {
    test.skip(
      !testInfo.project.name.startsWith("Mobile "),
      "The regression targets the compact mobile reader layout.",
    );
    await page.setViewportSize({ width: 390, height: 844 });
    await gotoLibrary(page);
    await importEpub(page, FIXTURE_READER);
    await waitForBookTitle(page, "閱讀夾具");
    await openBook(page, "閱讀夾具");
    await selectTocEntry(page, /第二章/);

    const gate = page.locator("button.epub-parent-image-gate").first();
    await expect(gate).toBeVisible({ timeout: 20_000 });
    const geometry = await page.evaluate(() => {
      const gate = document
        .querySelector("button.epub-parent-image-gate")
        ?.getBoundingClientRect();
      const stage = document.querySelector(".reader-stage")?.getBoundingClientRect();
      const footer = document
        .querySelector(".reader-bottombar")
        ?.getBoundingClientRect();
      return {
        gate: gate
          ? {
              left: gate.left,
              right: gate.right,
              top: gate.top,
              bottom: gate.bottom,
              width: gate.width,
              height: gate.height,
            }
          : null,
        stage: stage
          ? {
              left: stage.left,
              right: stage.right,
              top: stage.top,
              bottom: stage.bottom,
            }
          : null,
        footer: footer
          ? {
              left: footer.left,
              right: footer.right,
              top: footer.top,
              bottom: footer.bottom,
            }
          : null,
      };
    });

    expect(geometry.gate, JSON.stringify(geometry)).not.toBeNull();
    expect(geometry.stage, JSON.stringify(geometry)).not.toBeNull();
    expect(geometry.footer, JSON.stringify(geometry)).not.toBeNull();
    expect(geometry.gate!.left, JSON.stringify(geometry)).toBeGreaterThanOrEqual(
      geometry.stage!.left - 1,
    );
    expect(geometry.gate!.right, JSON.stringify(geometry)).toBeLessThanOrEqual(
      geometry.stage!.right + 1,
    );
    expect(geometry.gate!.bottom, JSON.stringify(geometry)).toBeLessThanOrEqual(
      geometry.footer!.top + 1,
    );
  });

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

  test("does not disable pointer input for a reflowable paginated page", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await gotoLibrary(page);
    await importEpub(page, FIXTURE_LARGE);
    await waitForBookTitle(page, "長章節壓力夾具");
    await openBook(page, "長章節壓力夾具");

    await expect
      .poll(() =>
        page.evaluate(() => {
          const host = document.querySelector(".reader-host") as HTMLElement | null;
          const iframe = host?.querySelector("iframe");
          if (!host || !iframe) return { ready: false };
          return {
            ready: true,
            iframePointerEvents: getComputedStyle(iframe).pointerEvents,
            stageSwipe: host.dataset.readerStageSwipe,
          };
        }),
      )
      .toEqual({
        ready: true,
        iframePointerEvents: "auto",
        stageSwipe: "false",
      });
  });

  test("turns a reflowable page from a touch Pointer Event inside its iframe", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await gotoLibrary(page);
    await importEpub(page, FIXTURE_LARGE);
    await waitForBookTitle(page, "長章節壓力夾具");
    await openBook(page, "長章節壓力夾具");

    const before = await readReaderLocation(page);
    const iframe = page.locator(".reader-host iframe");
    await iframe.evaluate((element) => {
      element.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          pointerType: "touch",
          isPrimary: true,
          clientX: 300,
          clientY: 260,
        }),
      );
      element.dispatchEvent(
        new PointerEvent("pointerup", {
          bubbles: true,
          pointerType: "touch",
          isPrimary: true,
          clientX: 120,
          clientY: 260,
        }),
      );
    });

    await expect
      .poll(async () => readReaderLocation(page))
      .not.toEqual(before);
  });

  test("turns a non-interactive fixed-layout cover without blocking fixed-layout links", async ({
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

    const reader = page.getByLabel(/閱讀：/);
    await expect(page.locator(".reader-host")).toHaveAttribute(
      "data-reader-fixed-layout",
      "true",
    );
    await expect(page.locator(".reader-host")).toHaveAttribute(
      "data-reader-stage-swipe",
      "true",
    );
    await page.locator(".reader-host").evaluate((host) => {
      for (const [type, x] of [
        ["touchstart", 300],
        ["touchend", 120],
      ] as const) {
        const event = new Event(type, { bubbles: true });
        const touch = { clientX: x, clientY: 260 };
        Object.defineProperty(event, "touches", {
          value: type === "touchend" ? [] : [touch],
        });
        Object.defineProperty(event, "changedTouches", { value: [touch] });
        host.dispatchEvent(event);
      }
    });
    await expect(reader).toHaveAttribute("data-spine-index", "1");
    await expect(page.locator(".reader-host")).toHaveAttribute(
      "data-reader-fixed-layout",
      "true",
    );
    await expect(page.locator(".reader-host iframe")).toHaveCSS(
      "pointer-events",
      "auto",
    );
    await page
      .locator(".epub-link-dock")
      .getByRole("button", { name: "前往書內連結：chapter.xhtml" })
      .click();
    await expect(reader).toHaveAttribute("data-spine-index", "3");
    await expect(page.locator(".reader-host")).toHaveAttribute(
      "data-reader-fixed-layout",
      "false",
    );
    await expect(page.locator(".reader-host iframe")).toHaveCSS(
      "pointer-events",
      "auto",
    );
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

  test("font size changes keep a single paginated column inside the viewport", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 390, height: 844 });
    await gotoLibrary(page);
    await importEpub(page, FIXTURE_LARGE);
    await waitForBookTitle(page, "長章節壓力夾具");
    await openBook(page, "長章節壓力夾具");

    await expect(page.locator(".reader-screen--paginated")).toBeVisible();
    const before = await waitForStableReaderLocation(page);
    expect(before.spineHref.length).toBeGreaterThan(0);
    const geometryBefore = await readPaginatedStageGeometry(page);
    expect(geometryBefore.singleVisiblePage).toBe(true);

    // Rapid A+ taps — the real user path that used to flash multi-columns.
    await bumpFontSize(page, 3);

    await expect
      .poll(async () => {
        const g = await readPaginatedStageGeometry(page);
        return g.singleVisiblePage;
      }, { timeout: 15_000 })
      .toBe(true);

    const geometry = await readPaginatedStageGeometry(page);
    expect(geometry.stageRight).toBeLessThanOrEqual(geometry.viewportWidth + 2);
    expect(geometry.hostRight).toBeLessThanOrEqual(geometry.viewportWidth + 2);
    expect(geometry.nextEdgeRight).toBeLessThanOrEqual(geometry.viewportWidth + 2);
    // Host must not expand after font-size reflow (multi-column flash grows it).
    expect(geometry.hostWidth).toBeLessThanOrEqual(geometryBefore.hostWidth + 4);

    const afterFont = await waitForStableReaderLocation(page);
    expect(afterFont.spineHref).toBe(before.spineHref);

    await page.getByRole("button", { name: "下一頁" }).first().click();
    const afterNext = await waitForStableReaderLocation(page);
    expect(
      afterNext.cfi !== afterFont.cfi ||
        afterNext.percent !== afterFont.percent,
    ).toBe(true);
  });

  test("background changes remeasure paginated columns before settings close", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 390, height: 844 });
    await gotoLibrary(page);
    await importEpub(page, FIXTURE_LARGE);
    await waitForBookTitle(page, "長章節壓力夾具");
    await openBook(page, "長章節壓力夾具");

    expect((await readPaginatedStageGeometry(page)).singleVisiblePage).toBe(true);

    await openSettings(page);
    await page.getByRole("radio", { name: "白色" }).click();
    await closeSettings(page);

    await expect
      .poll(async () => (await readPaginatedStageGeometry(page)).singleVisiblePage, {
        timeout: 15_000,
      })
      .toBe(true);
  });

  test("scrolled flow remains scrollable after host containment CSS", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 390, height: 844 });
    await gotoLibrary(page);
    await importEpub(page, FIXTURE_LARGE);
    await waitForBookTitle(page, "長章節壓力夾具");
    await openBook(page, "長章節壓力夾具");

    await setFlow(page, "捲動");
    await expect(page.locator(".reader-screen--scrolled")).toBeVisible();
    await page.waitForTimeout(600);

    const scrollProbe = await page.evaluate(() => {
      const host = document.querySelector(".reader-host") as HTMLElement | null;
      if (!host) return { found: false as const };

      const candidates: HTMLElement[] = [host];
      host.querySelectorAll("*").forEach((el) => {
        if (el instanceof HTMLElement) candidates.push(el);
      });

      for (const el of candidates) {
        if (el.scrollHeight > el.clientHeight + 8) {
          const before = el.scrollTop;
          el.scrollTop = Math.min(el.scrollHeight, before + 240);
          const after = el.scrollTop;
          return {
            found: true as const,
            scrollHeight: el.scrollHeight,
            clientHeight: el.clientHeight,
            before,
            after,
            hostOverflow: getComputedStyle(host).overflow,
          };
        }
      }
      return { found: false as const };
    });

    expect(scrollProbe.found).toBe(true);
    if (scrollProbe.found) {
      expect(scrollProbe.scrollHeight).toBeGreaterThan(scrollProbe.clientHeight);
      expect(scrollProbe.after).toBeGreaterThan(scrollProbe.before);
      // Scrolled mode must not force host overflow:hidden (paginated-only clip).
      expect(scrollProbe.hostOverflow).not.toMatch(/hidden/i);
    }

    // End of chapter remains reachable via location progress after scroll.
    const loc = await readReaderLocation(page);
    expect(loc.spineHref.length).toBeGreaterThan(0);
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
