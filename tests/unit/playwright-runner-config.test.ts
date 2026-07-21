import { describe, expect, it } from "vitest";
import packageJson from "../../package.json?raw";
import playwrightConfig from "../../playwright.config.ts?raw";

describe("Playwright runner configuration", () => {
  it("builds before Playwright starts and avoids the hanging webServer hook", () => {
    const scripts = JSON.parse(packageJson).scripts as Record<string, string>;

    expect(scripts["test:e2e"]).toBe("npm run build && playwright test");
    expect(playwrightConfig).not.toMatch(/\bwebServer\s*:/);
    expect(playwrightConfig).toMatch(
      /globalSetup:\s*"\.\/tests\/e2e\/global-setup\.ts"/,
    );
    expect(playwrightConfig).toMatch(
      /globalTeardown:\s*"\.\/tests\/e2e\/global-teardown\.ts"/,
    );
  });
});
