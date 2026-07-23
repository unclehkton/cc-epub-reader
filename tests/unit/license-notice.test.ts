import { describe, expect, it } from "vitest";
import { listShippedLicenses } from "../../src/ui/license-notice";

describe("listShippedLicenses", () => {
  it("includes OpenCC with copyright and dual license notice", () => {
    const entries = listShippedLicenses();
    const opencc = entries.find((e) => e.name === "opencc-js");
    expect(opencc).toBeTruthy();
    expect(opencc!.license).toMatch(/MIT/i);
    expect(opencc!.copyright).toMatch(/nk2028/i);
    expect(opencc!.notice.length).toBeGreaterThan(20);

    const data = entries.find((e) => e.name.includes("opencc-data"));
    expect(data?.license).toMatch(/Apache/i);
  });

  it("lists other runtime dependencies with copyright notices", () => {
    const names = listShippedLicenses().map((e) => e.name);
    expect(names).toEqual(
      expect.arrayContaining(["epubjs", "jszip", "preact"]),
    );
  });
});
