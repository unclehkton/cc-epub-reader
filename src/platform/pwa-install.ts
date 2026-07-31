export type PwaInstallPlatform = "iphone" | "android" | null;

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
  if (/iphone|ipod/i.test(environment.userAgent)) return "iphone";
  if (/android/i.test(environment.userAgent)) return "android";
  return null;
}
