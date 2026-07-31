import { useCallback, useEffect, useMemo, useState } from "preact/hooks";
import {
  getPwaInstallPlatform,
  type DeferredInstallPromptEvent,
  type PwaInstallPlatform,
} from "./pwa-install";

export interface PwaInstallPromptModel {
  platform: PwaInstallPlatform;
  visible: boolean;
  canPromptInstall: boolean;
  dismiss(): void;
  promptInstall(): Promise<void>;
}

function readPlatform(): PwaInstallPlatform {
  if (typeof window === "undefined" || typeof navigator === "undefined") {
    return null;
  }
  const match = (query: string): boolean => {
    try {
      return typeof window.matchMedia === "function" && window.matchMedia(query).matches;
    } catch {
      return false;
    }
  };
  return getPwaInstallPlatform({
    userAgent: navigator.userAgent,
    standalone: Boolean((navigator as Navigator & { standalone?: boolean }).standalone),
    displayModeStandalone: match("(display-mode: standalone)"),
    displayModeFullscreen: match("(display-mode: fullscreen)"),
  });
}

/**
 * Keeps install guidance local to this page lifetime. Android's browser-owned
 * event is optional; iPhone only needs the static Safari instruction.
 */
export function usePwaInstallPrompt(): PwaInstallPromptModel {
  const [platform, setPlatform] = useState<PwaInstallPlatform>(readPlatform);
  const [dismissed, setDismissed] = useState(false);
  const [deferredEvent, setDeferredEvent] =
    useState<DeferredInstallPromptEvent | null>(null);

  useEffect(() => {
    setPlatform(readPlatform());
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      setDeferredEvent(event as DeferredInstallPromptEvent);
    };
    const onAppInstalled = () => {
      setDeferredEvent(null);
      setDismissed(true);
    };
    window.addEventListener("beforeinstallprompt", onBeforeInstallPrompt);
    window.addEventListener("appinstalled", onAppInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt);
      window.removeEventListener("appinstalled", onAppInstalled);
    };
  }, []);

  const dismiss = useCallback(() => {
    setDismissed(true);
  }, []);

  const promptInstall = useCallback(async () => {
    if (!deferredEvent) return;
    try {
      await deferredEvent.prompt();
      await deferredEvent.userChoice;
    } finally {
      setDeferredEvent(null);
      setDismissed(true);
    }
  }, [deferredEvent]);

  return useMemo(
    () => ({
      platform,
      visible: platform !== null && !dismissed,
      canPromptInstall: platform === "android" && deferredEvent !== null,
      dismiss,
      promptInstall,
    }),
    [deferredEvent, dismiss, dismissed, platform, promptInstall],
  );
}
