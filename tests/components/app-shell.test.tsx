import { render, screen } from "@testing-library/preact";
import { describe, expect, it } from "vitest";
import { App } from "../../src/app";
import viteConfig from "../../vite.config";

describe("App", () => {
  it("introduces the private local library", () => {
    render(<App />);
    expect(screen.getByRole("heading", { name: "你的書庫" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "匯入 EPUB" })).toBeTruthy();
    expect(screen.getByText("書籍只會儲存在此裝置")).toBeTruthy();
  });

  it("configures Vite build.target as es2019 for Safari/iOS 15", () => {
    expect(viteConfig.build?.target).toBe("es2019");
  });

  it("sizes the 匯入 EPUB control for a 44px touch target", () => {
    render(<App />);
    const importButton = screen.getByRole("button", { name: "匯入 EPUB" });
    const styles = getComputedStyle(importButton);

    // Explicit px min sizes prove the touch-target styles are present (not browser "auto"/absent).
    expect(styles.minWidth).toMatch(/px$/);
    expect(styles.minHeight).toMatch(/px$/);
    expect(parseFloat(styles.minWidth)).toBeGreaterThanOrEqual(44);
    expect(parseFloat(styles.minHeight)).toBeGreaterThanOrEqual(44);
  });
});
