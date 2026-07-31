import { render, screen } from "@testing-library/preact";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { PwaInstallPrompt } from "../../src/library/pwa-install-prompt";
import type { PwaInstallPromptModel } from "../../src/platform/use-pwa-install-prompt";

function makeModel(
  overrides: Partial<PwaInstallPromptModel> = {},
): PwaInstallPromptModel {
  return {
    platform: "iphone",
    visible: true,
    canPromptInstall: false,
    dismiss: vi.fn(),
    promptInstall: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("PwaInstallPrompt", () => {
  it("shows the iPhone Safari share instruction", () => {
    render(<PwaInstallPrompt model={makeModel()} />);

    expect(screen.getByRole("heading", { name: "將書庫加入主畫面" })).toBeTruthy();
    expect(screen.getByText(/Safari 分享按鈕/)).toBeTruthy();
    expect(screen.getByText(/「加入主畫面」/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "立即安裝" })).toBeNull();
  });

  it("uses Android fallback copy when native installation is unavailable", () => {
    render(
      <PwaInstallPrompt
        model={makeModel({ platform: "android", canPromptInstall: false })}
      />,
    );

    expect(screen.getByText(/Chrome.*選單/)).toBeTruthy();
  });

  it("opens the Android native prompt and supports session dismissal", async () => {
    const user = userEvent.setup();
    const promptInstall = vi.fn().mockResolvedValue(undefined);
    const dismiss = vi.fn();
    render(
      <PwaInstallPrompt
        model={makeModel({
          platform: "android",
          canPromptInstall: true,
          promptInstall,
          dismiss,
        })}
      />,
    );

    await user.click(screen.getByRole("button", { name: "立即安裝" }));
    expect(promptInstall).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("button", { name: "關閉安裝提示" }));
    expect(dismiss).toHaveBeenCalledOnce();
  });

  it("renders nothing when its model is hidden", () => {
    const { container } = render(
      <PwaInstallPrompt model={makeModel({ visible: false })} />,
    );
    expect(container.textContent).toBe("");
  });
});
