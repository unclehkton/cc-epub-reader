import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page } from "@playwright/test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const FIXTURE_READER = path.resolve(
  __dirname,
  "../fixtures/reader-fixture.epub",
);
export const FIXTURE_LARGE = path.resolve(
  __dirname,
  "../fixtures/large-chapter.epub",
);

/** Second copy of the reader fixture under a distinct file name for dual-import tests. */
export const FIXTURE_READER_B = FIXTURE_READER;

export async function gotoLibrary(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "你的書庫" })).toBeVisible();
}

export async function importEpub(
  page: Page,
  fixturePath: string,
): Promise<void> {
  const input = page.locator('input[type="file"]');
  await expect(input).toBeAttached();
  await input.setInputFiles(fixturePath);
  // Wait until the import control is no longer disabled (import finished).
  await expect(page.getByRole("button", { name: "匯入 EPUB" })).toBeEnabled({
    timeout: 60_000,
  });
}

export async function waitForBookTitle(
  page: Page,
  title: string | RegExp,
): Promise<void> {
  await expect(page.getByText(title).first()).toBeVisible({ timeout: 30_000 });
}

export async function openBook(page: Page, title: string | RegExp): Promise<void> {
  const button = page.getByRole("button", {
    name: typeof title === "string" ? `開啟 ${title}` : new RegExp(`開啟 ${title.source}`),
  });
  await button.click();
  await expect(page.getByLabel(/閱讀：/)).toBeVisible({ timeout: 60_000 });
  // Wait for loading indicator to clear when present.
  const loading = page.getByText("載入中…");
  if (await loading.count()) {
    await expect(loading).toBeHidden({ timeout: 60_000 });
  }
}

export async function closeReader(page: Page): Promise<void> {
  await page.getByRole("button", { name: "返回書庫" }).click();
  await expect(page.getByRole("heading", { name: "你的書庫" })).toBeVisible({
    timeout: 30_000,
  });
}

export async function openSettings(page: Page): Promise<void> {
  await page.getByRole("button", { name: "閱讀設定" }).click();
  await expect(page.getByRole("dialog", { name: "閱讀設定" })).toBeVisible();
}

async function closeSettings(page: Page): Promise<void> {
  const dialog = page.getByRole("dialog", { name: "閱讀設定" });
  // Prefer the in-sheet close control; the backdrop shares the same accessible name
  // but is covered by the sheet and cannot receive pointer events.
  await dialog.getByRole("button", { name: "關閉設定" }).click();
  await expect(dialog).toBeHidden();
}

export async function setFlow(
  page: Page,
  flow: "分頁" | "捲動",
): Promise<void> {
  await openSettings(page);
  await page.getByRole("radio", { name: flow }).click();
  await closeSettings(page);
}

export async function setConversionHongKong(page: Page): Promise<void> {
  await openSettings(page);
  await page.getByRole("radio", { name: "香港繁體" }).click();
  // Give OpenCC lazy chunk time to apply.
  await page.waitForTimeout(800);
  await closeSettings(page);
}

export async function openToc(page: Page): Promise<void> {
  const tocNav = page.getByRole("navigation", { name: "目錄" });
  if (await tocNav.isVisible().catch(() => false)) {
    return;
  }
  await page.getByRole("button", { name: "目錄" }).click();
  await expect(tocNav).toBeVisible();
}

export async function selectTocEntry(
  page: Page,
  label: string | RegExp,
): Promise<void> {
  await openToc(page);
  await page
    .getByRole("navigation", { name: "目錄" })
    .getByRole("button", { name: label })
    .click();
}

/**
 * Collect frames that may host EPUB.js chapter content.
 */
export function contentFrames(page: Page) {
  return page.frames().filter((frame) => frame !== page.mainFrame());
}

export async function findInContentFrames(
  page: Page,
  selector: string,
  timeoutMs = 20_000,
): Promise<{ frameIndex: number; count: number }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const frames = contentFrames(page);
    for (let i = 0; i < frames.length; i += 1) {
      try {
        const count = await frames[i]!.locator(selector).count();
        if (count > 0) {
          return { frameIndex: i, count };
        }
      } catch {
        // Frame may be navigating.
      }
    }
    await page.waitForTimeout(200);
  }
  throw new Error(`Selector not found in content frames: ${selector}`);
}

export async function clickImageGate(page: Page): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    for (const frame of contentFrames(page)) {
      try {
        const gate = frame.getByRole("button", { name: "點擊顯示圖片" });
        if ((await gate.count()) > 0) {
          // force: WebKit iframe hit-testing can be flaky with EPUB.js overlays.
          await gate.first().click({ force: true });
          // Also dispatch a DOM click in-frame as a WebKit fallback.
          await frame.evaluate(() => {
            const buttons = Array.from(document.querySelectorAll("button"));
            const target = buttons.find(
              (b) =>
                (b.getAttribute("aria-label") || "").includes("點擊顯示圖片") ||
                (b.textContent || "").includes("點擊顯示圖片"),
            );
            target?.dispatchEvent(
              new MouseEvent("click", { bubbles: true, cancelable: true }),
            );
          });
          return;
        }
      } catch {
        // ignore transient frame errors
      }
    }
    await page.waitForTimeout(250);
  }
  throw new Error("Image gate button 點擊顯示圖片 not found");
}

export async function contentTextIncludes(
  page: Page,
  text: string | RegExp,
  timeoutMs = 20_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const matcher =
    typeof text === "string"
      ? (value: string) => value.includes(text)
      : (value: string) => text.test(value);

  while (Date.now() < deadline) {
    for (const frame of contentFrames(page)) {
      try {
        const body = await frame.locator("body").innerText({ timeout: 1000 });
        if (matcher(body)) {
          return true;
        }
      } catch {
        // ignore
      }
    }
    await page.waitForTimeout(200);
  }
  return false;
}

export async function deleteBook(page: Page, title: string): Promise<void> {
  await page.getByRole("button", { name: `更多：${title}` }).click();
  await page.getByRole("menuitem", { name: "刪除" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "刪除" }).click();
  await expect(page.getByRole("button", { name: `開啟 ${title}` })).toHaveCount(
    0,
  );
}

/** Wait until the service worker controlling this page is ready. */
export async function waitForServiceWorker(page: Page): Promise<void> {
  await page.waitForFunction(async () => {
    if (!("serviceWorker" in navigator)) return false;
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg) return false;
    return Boolean(navigator.serviceWorker.controller || reg.active);
  }, undefined, { timeout: 60_000 });
}
