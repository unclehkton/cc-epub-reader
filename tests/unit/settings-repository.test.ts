import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  parseStoredSettings,
} from "../../src/settings/settings-repository";

describe("parseStoredSettings", () => {
  it("defaults new fields for incomplete records", () => {
    const parsed = parseStoredSettings({ key: "reader", flow: "paginated" });
    expect(parsed.horizontalMarginPercent).toBe(
      DEFAULT_SETTINGS.horizontalMarginPercent,
    );
    expect(parsed.tocSide).toBe("left");
    expect(parsed.uiLanguage).toBe("zh-Hant");
    expect(parsed.conversion).toBe("original");
  });

  it("accepts simplified conversion and clamps margins", () => {
    const parsed = parseStoredSettings({
      key: "reader",
      flow: "paginated",
      conversion: "simplified",
      fontSizePercent: 100,
      fontFamily: "book",
      background: "rice",
      theme: "system",
      horizontalMarginPercent: 99,
      tocSide: "right",
      uiLanguage: "zh-Hans",
    });
    expect(parsed.conversion).toBe("simplified");
    expect(parsed.horizontalMarginPercent).toBe(20);
    expect(parsed.tocSide).toBe("right");
    expect(parsed.uiLanguage).toBe("zh-Hans");
  });

  it("rejects invalid enums", () => {
    const parsed = parseStoredSettings({
      key: "reader",
      conversion: "s2t-invalid",
      tocSide: "top",
      uiLanguage: "en",
      horizontalMarginPercent: -5,
    });
    expect(parsed.conversion).toBe("original");
    expect(parsed.tocSide).toBe("left");
    expect(parsed.uiLanguage).toBe("zh-Hant");
    expect(parsed.horizontalMarginPercent).toBe(0);
  });
});
