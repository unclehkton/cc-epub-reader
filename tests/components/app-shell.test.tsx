import { render, screen } from "@testing-library/preact";
import { describe, expect, it } from "vitest";
import { App } from "../../src/app";

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
});
