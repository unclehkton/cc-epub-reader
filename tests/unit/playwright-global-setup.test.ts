import { describe, expect, it, vi } from "vitest";
import { verifyBrowserLaunchers } from "../../tests/e2e/global-setup";

describe("Playwright browser preflight", () => {
  it("launches and closes every required browser before the suite", async () => {
    const closeChromium = vi.fn(async () => undefined);
    const closeWebKit = vi.fn(async () => undefined);

    await verifyBrowserLaunchers([
      {
        name: "Chromium",
        launch: vi.fn(async () => ({ close: closeChromium })),
      },
      {
        name: "WebKit",
        launch: vi.fn(async () => ({ close: closeWebKit })),
      },
    ]);

    expect(closeChromium).toHaveBeenCalledOnce();
    expect(closeWebKit).toHaveBeenCalledOnce();
  });

  it("fails once with an install command when a browser cannot launch", async () => {
    await expect(
      verifyBrowserLaunchers([
        {
          name: "WebKit",
          launch: vi.fn(async () => {
            throw new Error("Executable does not exist");
          }),
        },
      ]),
    ).rejects.toThrow(
      "WebKit could not launch. Run: npx playwright install chromium webkit",
    );
  });

  it("times out a browser launch instead of hanging the release gate", async () => {
    vi.useFakeTimers();
    try {
      const preflight = verifyBrowserLaunchers(
        [
          {
            name: "Chromium",
            launch: () => new Promise(() => undefined),
          },
        ],
        1_000,
      );
      const rejection = expect(preflight).rejects.toThrow(
        "Chromium could not launch. Run: npx playwright install chromium webkit",
      );

      await vi.advanceTimersByTimeAsync(1_000);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });
});
