import { describe, expect, it } from "vitest";
import { getPwaInstallPlatform } from "../../src/platform/pwa-install";

describe("getPwaInstallPlatform", () => {
  it("returns iphone for an uninstalled iPhone browser", () => {
    expect(
      getPwaInstallPlatform({
        userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)",
        standalone: false,
        displayModeStandalone: false,
        displayModeFullscreen: false,
      }),
    ).toBe("iphone");
  });

  it("returns android for an uninstalled Android browser", () => {
    expect(
      getPwaInstallPlatform({
        userAgent: "Mozilla/5.0 (Linux; Android 15)",
        standalone: false,
        displayModeStandalone: false,
        displayModeFullscreen: false,
      }),
    ).toBe("android");
  });

  it.each([
    {
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)",
      standalone: true,
      displayModeStandalone: false,
      displayModeFullscreen: false,
    },
    {
      userAgent: "Mozilla/5.0 (Linux; Android 15)",
      standalone: false,
      displayModeStandalone: true,
      displayModeFullscreen: false,
    },
    {
      userAgent: "Mozilla/5.0 (Linux; Android 15)",
      standalone: false,
      displayModeStandalone: false,
      displayModeFullscreen: true,
    },
    {
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
      standalone: false,
      displayModeStandalone: false,
      displayModeFullscreen: false,
    },
  ])("returns null for an ineligible browser state %#", (input) => {
    expect(getPwaInstallPlatform(input)).toBeNull();
  });
});
