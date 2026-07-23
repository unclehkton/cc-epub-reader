import { afterEach, describe, expect, it } from "vitest";
import { clearConverterCache } from "../../src/reader/opencc-profiles";
import { convertLabels } from "../../src/reader/convert-labels";

describe("convertLabels", () => {
  afterEach(() => {
    clearConverterCache();
  });

  it("leaves labels unchanged for original mode", async () => {
    await expect(convertLabels(["第一章", "汉语"], "original")).resolves.toEqual([
      "第一章",
      "汉语",
    ]);
  });

  it("converts simplified source labels to traditional", async () => {
    const out = await convertLabels(["汉语软件"], "traditional");
    expect(out[0]).toBe("漢語軟件");
  });

  it("converts traditional labels to simplified", async () => {
    const out = await convertLabels(["漢語軟體"], "simplified");
    expect(out[0]).toMatch(/汉语/);
  });
});
