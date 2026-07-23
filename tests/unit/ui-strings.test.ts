import { describe, expect, it } from "vitest";
import { t } from "../../src/ui/strings";

describe("ui strings", () => {
  it("returns traditional Chinese by default", () => {
    expect(t(undefined, "settings")).toBe("設定");
    expect(t("zh-Hant", "toc")).toBe("目錄");
  });

  it("returns simplified Chinese chrome when uiLanguage is zh-Hans", () => {
    expect(t("zh-Hans", "settings")).toBe("设置");
    expect(t("zh-Hans", "toc")).toBe("目录");
    expect(t("zh-Hans", "licensesTitle")).toContain("授权");
  });
});
