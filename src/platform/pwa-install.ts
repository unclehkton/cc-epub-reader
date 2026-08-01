export type PwaInstallPlatform = "iphone" | "ios-browser" | "android" | null;

export interface PwaInstallEnvironment {
  userAgent: string;
  standalone: boolean;
  displayModeStandalone: boolean;
  displayModeFullscreen: boolean;
}

export interface DeferredInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

/**
 * Classify only browsers that need install guidance. Browser globals stay out
 * of this pure boundary so installed-PWA detection is easy to regression-test.
 */
export function getPwaInstallPlatform(
  environment: PwaInstallEnvironment,
): PwaInstallPlatform {
  if (
    environment.standalone ||
    environment.displayModeStandalone ||
    environment.displayModeFullscreen
  ) {
    return null;
  }
  if (/iphone|ipod/i.test(environment.userAgent)) {
    // Only Safari exposes the Share-sheet path for adding a site to the Home
    // Screen. iOS browsers and WKWebViews share much of Safari's UA, so use
    // Safari's own Version + Mobile + Safari shape positively rather than a
    // brittle block list of other browser tokens.
    return /version\/[\d.]+.*mobile\/[\w.]+.*safari\//i.test(
      environment.userAgent,
    )
      ? "iphone"
      : "ios-browser";
  }
  if (/android/i.test(environment.userAgent)) return "android";
  return null;
}
