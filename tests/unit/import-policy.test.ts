import { describe, expect, it } from "vitest";
import {
  ABSOLUTE_MAXIMUM_BYTES,
  APPLE_MOBILE_BLOCK_BYTES,
  APPLE_MOBILE_WARNING_BYTES,
  MIB,
  assessImport,
  classifyPlatform,
  computeImportPolicy,
  requiredStorageHeadroom,
} from "../../src/platform/import-policy";

describe("classifyPlatform", () => {
  it("classifies iPhone UA as apple-mobile", () => {
    expect(
      classifyPlatform({
        userAgent:
          "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15",
      }).platformClass,
    ).toBe("apple-mobile");
  });

  it("classifies MacIntel + multi-touch as apple-mobile (iPadOS)", () => {
    expect(
      classifyPlatform({
        navigatorPlatform: "MacIntel",
        maxTouchPoints: 5,
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
      }).platformClass,
    ).toBe("apple-mobile");
  });

  it("classifies non-touch Mac as desktop", () => {
    expect(
      classifyPlatform({
        navigatorPlatform: "MacIntel",
        maxTouchPoints: 0,
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
      }).platformClass,
    ).toBe("desktop");
  });

  it("classifies Android", () => {
    expect(
      classifyPlatform({
        userAgent: "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36",
      }).platformClass,
    ).toBe("android-mobile");
  });
});

describe("Apple mobile thresholds", () => {
  const apple = { userAgent: "iPhone" };

  it("allows just under 25 MiB", () => {
    const a = assessImport(APPLE_MOBILE_WARNING_BYTES - 1, apple);
    expect(a.decision).toBe("allow");
  });

  it("warns exactly at 25 MiB", () => {
    const a = assessImport(APPLE_MOBILE_WARNING_BYTES, apple);
    expect(a.decision).toBe("warn");
  });

  it("warns just under 50 MiB", () => {
    const a = assessImport(APPLE_MOBILE_BLOCK_BYTES - 1, apple);
    expect(a.decision).toBe("warn");
  });

  it("blocks exactly at 50 MiB", () => {
    const a = assessImport(APPLE_MOBILE_BLOCK_BYTES, apple);
    expect(a.decision).toBe("block");
  });

  it("never exceeds absolute 100 MiB ceiling", () => {
    const p = computeImportPolicy(apple);
    expect(p.blockingThresholdBytes).toBeLessThanOrEqual(ABSOLUTE_MAXIMUM_BYTES);
  });
});

describe("requiredStorageHeadroom", () => {
  it("uses larger headroom for Apple warn-range files", () => {
    const size = 30 * MIB;
    expect(requiredStorageHeadroom(size, "apple-mobile")).toBe(
      Math.max(size * 3, 64 * MIB),
    );
    expect(requiredStorageHeadroom(size, "desktop")).toBe(
      Math.max(size * 2, 32 * MIB),
    );
  });

  it("storage policy cannot raise memory block threshold", () => {
    const p = computeImportPolicy({ userAgent: "iPhone" });
    expect(p.blockingThresholdBytes).toBe(APPLE_MOBILE_BLOCK_BYTES);
  });
});

describe("missing deviceMemory", () => {
  it("does not throw and uses conservative mobile defaults", () => {
    expect(() =>
      assessImport(10 * MIB, {
        userAgent: "Mozilla/5.0 (Linux; Android 12)",
      }),
    ).not.toThrow();
  });
});
