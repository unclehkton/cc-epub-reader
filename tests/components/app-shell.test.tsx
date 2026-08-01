import { render, screen } from "@testing-library/preact";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../../src/app";

const originalUserAgent = Object.getOwnPropertyDescriptor(navigator, "userAgent");
const originalMatchMedia = window.matchMedia;

function setUserAgent(userAgent: string): void {
  Object.defineProperty(navigator, "userAgent", {
    configurable: true,
    value: userAgent,
  });
}

afterEach(() => {
  if (originalUserAgent) {
    Object.defineProperty(navigator, "userAgent", originalUserAgent);
  }
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: originalMatchMedia,
  });
});

describe("App", () => {
  it("introduces the private local library", async () => {
    render(<App />);
    expect(
      await screen.findByRole("heading", { name: "你的書庫" }, { timeout: 5000 }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "匯入 EPUB" })).toBeTruthy();
    expect(screen.getByText("書籍只會儲存在此裝置")).toBeTruthy();
  });

  it("configures Vite build.target as es2019 for Safari/iOS 15", async () => {
    const configModule = await import("../../vite.config");
    const exported = configModule.default as
      | { build?: { target?: string } }
      | ((env: { command: string; mode: string }) => {
          build?: { target?: string };
        });
    const config =
      typeof exported === "function"
        ? exported({ command: "build", mode: "production" })
        : exported;
    expect(config.build?.target).toBe("es2019");
  });

  it("sizes the 匯入 EPUB control for a 44px touch target", async () => {
    render(<App />);
    const importButton = await screen.findByRole(
      "button",
      { name: "匯入 EPUB" },
      { timeout: 5000 },
    );
    const styles = getComputedStyle(importButton);

    expect(Number.parseFloat(styles.minWidth)).toBeGreaterThanOrEqual(44);
    expect(Number.parseFloat(styles.minHeight)).toBeGreaterThanOrEqual(44);
  });

  it("shows iPhone Safari instructions outside installed display mode", async () => {
    setUserAgent(
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
    );
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({ matches: false })),
    });
    render(<App />);
    expect(await screen.findByText(/Safari 分享按鈕/)).toBeTruthy();
  });

  it("hides the install card when standalone display mode is active", async () => {
    setUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)");
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn((query: string) => ({
        matches: query === "(display-mode: standalone)",
      })),
    });
    render(<App />);
    expect(screen.queryByRole("heading", { name: "將書庫加入主畫面" })).toBeNull();
  });

  it("offers Android native installation and hides after the choice", async () => {
    setUserAgent("Mozilla/5.0 (Linux; Android 15)");
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({ matches: false })),
    });
    render(<App />);
    const prompt = vi.fn().mockResolvedValue(undefined);
    const event = new Event("beforeinstallprompt", { cancelable: true });
    Object.assign(event, {
      prompt,
      userChoice: Promise.resolve({ outcome: "dismissed" }),
    });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "立即安裝" }));
    expect(prompt).toHaveBeenCalledOnce();
    expect(screen.queryByRole("heading", { name: "將書庫加入主畫面" })).toBeNull();
  });

  it("keeps Android fallback guidance after a native install prompt rejects", async () => {
    setUserAgent("Mozilla/5.0 (Linux; Android 15)");
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({ matches: false })),
    });
    render(<App />);
    const prompt = vi.fn().mockRejectedValue(new Error("prompt blocked"));
    const event = new Event("beforeinstallprompt", { cancelable: true });
    Object.assign(event, {
      prompt,
      userChoice: Promise.resolve({ outcome: "dismissed" }),
    });
    window.dispatchEvent(event);

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "立即安裝" }));
    expect(prompt).toHaveBeenCalledOnce();
    expect(await screen.findByText(/Chrome.*選單/)).toBeTruthy();
  });
});
