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
    // iOS 15 third-party browsers cannot add a site to the Home Screen. Keep
    // Safari's instruction accurate instead of presenting its share UI in
    // Chrome/Firefox/embedded web views.
    if (/crios|fxios|edgios|opios|gsa|fbav|fban|instagram/i.test(environment.userAgent)) {
      return "ios-browser";
    }
    return "iphone";
  }
  if (/android/i.test(environment.userAgent)) return "android";
  return null;
}
