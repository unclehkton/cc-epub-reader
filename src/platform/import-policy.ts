/**
 * Pure, deterministic import memory policy for Release 0.1.
 * Side-effect free — unit-testable without a browser.
 */

export const MIB = 1024 * 1024;
export const ABSOLUTE_MAXIMUM_BYTES = 100 * MIB;

export const APPLE_MOBILE_WARNING_BYTES = 25 * MIB;
export const APPLE_MOBILE_BLOCK_BYTES = 50 * MIB;

export type PlatformClass =
  | "apple-mobile"
  | "android-mobile"
  | "desktop"
  | "unknown-mobile"
  | "unknown";

export type ImportDecision = "allow" | "warn" | "block";

export interface ImportCapabilitySignals {
  userAgent?: string;
  uaDataPlatform?: string;
  uaDataMobile?: boolean;
  navigatorPlatform?: string;
  maxTouchPoints?: number;
  deviceMemoryGiB?: number;
}

export interface ImportPolicy {
  platformClass: PlatformClass;
  warningThresholdBytes: number | null;
  blockingThresholdBytes: number;
  absoluteMaximumBytes: number;
  requiredStorageHeadroomBytes: number;
  policyVersion: number;
  reason: string;
}

export interface ImportAssessment {
  decision: ImportDecision;
  fileSizeBytes: number;
  warningThresholdBytes: number | null;
  blockingThresholdBytes: number;
  platformClass: PlatformClass;
  reason: string;
}

/** Small profile persisted for share-target (no fingerprinting). */
export interface StoredImportPolicyProfile {
  platformClass: PlatformClass;
  warningThresholdBytes: number | null;
  blockingThresholdBytes: number;
  policyVersion: number;
  computedAt: number;
}

export const IMPORT_POLICY_VERSION = 1;

const FALLBACK_WARN = 25 * MIB;
const FALLBACK_BLOCK = 50 * MIB;

export function classifyPlatform(
  signals: ImportCapabilitySignals = {},
): { platformClass: PlatformClass; reason: string } {
  const ua = (signals.userAgent ?? "").toLowerCase();
  const uaPlatform = (signals.uaDataPlatform ?? "").toLowerCase();
  const navPlatform = (signals.navigatorPlatform ?? "").toLowerCase();
  const touch = signals.maxTouchPoints ?? 0;
  const uaMobile = signals.uaDataMobile;

  // Apple mobile from UA
  if (/iphone|ipod|ipad/.test(ua)) {
    return { platformClass: "apple-mobile", reason: "apple-ua" };
  }
  // iPadOS desktop-mode masquerade
  if (
    (navPlatform === "macintel" || uaPlatform === "macos" || /macintosh/.test(ua)) &&
    touch > 1
  ) {
    return { platformClass: "apple-mobile", reason: "ipados-desktop-ua" };
  }

  if (uaMobile === true || /android/.test(ua) || uaPlatform === "android") {
    if (/android/.test(ua) || uaPlatform === "android") {
      return { platformClass: "android-mobile", reason: "android" };
    }
    return { platformClass: "unknown-mobile", reason: "ua-mobile" };
  }

  if (
    /win|mac|linux|cros/.test(uaPlatform) ||
    /win|mac|linux/.test(navPlatform) ||
    /windows|macintosh|linux|cros/.test(ua)
  ) {
    // Touch Mac already handled above; plain desktop
    return { platformClass: "desktop", reason: "desktop-ua" };
  }

  if (touch > 1 || uaMobile) {
    return { platformClass: "unknown-mobile", reason: "touch-fallback" };
  }

  if (!ua && !uaPlatform && !navPlatform) {
    return { platformClass: "unknown", reason: "no-signals" };
  }

  return { platformClass: "unknown", reason: "unclassified" };
}

function clampBlock(bytes: number): number {
  return Math.min(bytes, ABSOLUTE_MAXIMUM_BYTES);
}

function thresholdsFor(
  platformClass: PlatformClass,
  deviceMemoryGiB?: number,
): { warn: number | null; block: number; reason: string } {
  if (platformClass === "apple-mobile") {
    return {
      warn: APPLE_MOBILE_WARNING_BYTES,
      block: APPLE_MOBILE_BLOCK_BYTES,
      reason: "apple-mobile-50mib",
    };
  }

  const mem = deviceMemoryGiB;

  if (platformClass === "android-mobile" || platformClass === "unknown-mobile") {
    if (typeof mem === "number" && mem <= 2) {
      return { warn: 10 * MIB, block: clampBlock(20 * MIB), reason: "android-low-mem" };
    }
    if (typeof mem === "number" && mem <= 4) {
      return { warn: 20 * MIB, block: clampBlock(35 * MIB), reason: "android-mid-mem" };
    }
    if (typeof mem === "number" && mem <= 8) {
      return { warn: 30 * MIB, block: clampBlock(50 * MIB), reason: "android-high-mem" };
    }
    if (typeof mem === "number" && mem > 8) {
      return { warn: 50 * MIB, block: clampBlock(75 * MIB), reason: "android-very-high-mem" };
    }
    return {
      warn: FALLBACK_WARN,
      block: FALLBACK_BLOCK,
      reason: "android-unknown-mem",
    };
  }

  if (platformClass === "desktop") {
    if (typeof mem === "number" && mem <= 4) {
      return { warn: 40 * MIB, block: clampBlock(60 * MIB), reason: "desktop-low-mem" };
    }
    if (typeof mem === "number" && mem <= 8) {
      return { warn: 60 * MIB, block: clampBlock(85 * MIB), reason: "desktop-mid-mem" };
    }
    if (typeof mem === "number" && mem > 8) {
      return { warn: 80 * MIB, block: clampBlock(100 * MIB), reason: "desktop-high-mem" };
    }
    return { warn: 60 * MIB, block: clampBlock(85 * MIB), reason: "desktop-unknown-mem" };
  }

  // completely unknown
  return { warn: 40 * MIB, block: clampBlock(60 * MIB), reason: "unknown-default" };
}

export function computeImportPolicy(
  signals: ImportCapabilitySignals = {},
): ImportPolicy {
  const { platformClass, reason: classReason } = classifyPlatform(signals);
  const { warn, block, reason: threshReason } = thresholdsFor(
    platformClass,
    signals.deviceMemoryGiB,
  );

  const headroomBase =
    platformClass === "apple-mobile" ? 64 * MIB : 32 * MIB;

  return {
    platformClass,
    warningThresholdBytes: warn,
    blockingThresholdBytes: block,
    absoluteMaximumBytes: ABSOLUTE_MAXIMUM_BYTES,
    requiredStorageHeadroomBytes: headroomBase,
    policyVersion: IMPORT_POLICY_VERSION,
    reason: `${classReason}/${threshReason}`,
  };
}

export function assessImport(
  fileSizeBytes: number,
  signals: ImportCapabilitySignals = {},
): ImportAssessment {
  const policy = computeImportPolicy(signals);
  const size = Math.max(0, Math.floor(fileSizeBytes));

  if (size >= policy.absoluteMaximumBytes || size >= policy.blockingThresholdBytes) {
    return {
      decision: "block",
      fileSizeBytes: size,
      warningThresholdBytes: policy.warningThresholdBytes,
      blockingThresholdBytes: policy.blockingThresholdBytes,
      platformClass: policy.platformClass,
      reason: "over-block-threshold",
    };
  }

  if (
    policy.warningThresholdBytes !== null &&
    size >= policy.warningThresholdBytes
  ) {
    return {
      decision: "warn",
      fileSizeBytes: size,
      warningThresholdBytes: policy.warningThresholdBytes,
      blockingThresholdBytes: policy.blockingThresholdBytes,
      platformClass: policy.platformClass,
      reason: "over-warn-threshold",
    };
  }

  return {
    decision: "allow",
    fileSizeBytes: size,
    warningThresholdBytes: policy.warningThresholdBytes,
    blockingThresholdBytes: policy.blockingThresholdBytes,
    platformClass: policy.platformClass,
    reason: "under-warn-threshold",
  };
}

/** Storage headroom required before attempting durable import. */
export function requiredStorageHeadroom(
  fileSizeBytes: number,
  platformClass: PlatformClass,
): number {
  if (platformClass === "apple-mobile") {
    const inWarnRange =
      fileSizeBytes >= APPLE_MOBILE_WARNING_BYTES &&
      fileSizeBytes < APPLE_MOBILE_BLOCK_BYTES;
    if (inWarnRange) {
      return Math.max(fileSizeBytes * 3, 64 * MIB);
    }
  }
  return Math.max(fileSizeBytes * 2, 32 * MIB);
}

export function formatFileSizeMiB(bytes: number): string {
  const mib = bytes / MIB;
  if (mib < 10) return `${mib.toFixed(2)} MiB`;
  return `${mib.toFixed(1)} MiB`;
}

/** Collect browser signals when available (never throws). */
export function collectBrowserImportSignals(
  nav: Navigator | undefined = typeof navigator !== "undefined" ? navigator : undefined,
): ImportCapabilitySignals {
  if (!nav) return {};
  const signals: ImportCapabilitySignals = {};
  try {
    if (typeof nav.userAgent === "string") signals.userAgent = nav.userAgent;
  } catch {
    // ignore
  }
  try {
    if (typeof nav.platform === "string") signals.navigatorPlatform = nav.platform;
  } catch {
    // ignore
  }
  try {
    if (typeof nav.maxTouchPoints === "number") {
      signals.maxTouchPoints = nav.maxTouchPoints;
    }
  } catch {
    // ignore
  }
  try {
    const mem = (nav as Navigator & { deviceMemory?: number }).deviceMemory;
    if (typeof mem === "number" && Number.isFinite(mem)) {
      signals.deviceMemoryGiB = mem;
    }
  } catch {
    // ignore
  }
  try {
    const uaData = (
      nav as Navigator & {
        userAgentData?: { platform?: string; mobile?: boolean };
      }
    ).userAgentData;
    if (uaData) {
      if (typeof uaData.platform === "string") {
        signals.uaDataPlatform = uaData.platform;
      }
      if (typeof uaData.mobile === "boolean") {
        signals.uaDataMobile = uaData.mobile;
      }
    }
  } catch {
    // ignore
  }
  return signals;
}

export function toStoredProfile(policy: ImportPolicy): StoredImportPolicyProfile {
  return {
    platformClass: policy.platformClass,
    warningThresholdBytes: policy.warningThresholdBytes,
    blockingThresholdBytes: policy.blockingThresholdBytes,
    policyVersion: policy.policyVersion,
    computedAt: Date.now(),
  };
}

/** Share-target fallback when profile missing/stale. */
export function fallbackSharePolicy(): ImportPolicy {
  return {
    platformClass: "unknown-mobile",
    warningThresholdBytes: FALLBACK_WARN,
    blockingThresholdBytes: FALLBACK_BLOCK,
    absoluteMaximumBytes: ABSOLUTE_MAXIMUM_BYTES,
    requiredStorageHeadroomBytes: 64 * MIB,
    policyVersion: IMPORT_POLICY_VERSION,
    reason: "share-fallback",
  };
}
