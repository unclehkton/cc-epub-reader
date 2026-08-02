import type { PwaInstallPromptModel } from "../platform/use-pwa-install-prompt";
import type { UiLanguage } from "../domain/types";
import { t } from "../ui/strings";

export interface PwaInstallPromptProps {
  model: PwaInstallPromptModel;
  uiLanguage?: UiLanguage;
}

export function PwaInstallPrompt({
  model,
  uiLanguage = "zh-Hant",
}: PwaInstallPromptProps) {
  if (!model.visible || !model.platform) return null;

  const isIphone = model.platform === "iphone";
  return (
    <aside class="pwa-install-prompt" aria-labelledby="pwa-install-title">
      <span class="pwa-install-prompt__icon" aria-hidden="true">
        {isIphone ? "⇧" : "⌂"}
      </span>
      <div class="pwa-install-prompt__copy">
        <h2 id="pwa-install-title">{t(uiLanguage, "pwaInstallTitle")}</h2>
        {isIphone ? (
          <p>
            {t(uiLanguage, "pwaIphoneInstruction")} <span aria-hidden="true">⇧</span>
          </p>
        ) : model.platform === "ios-browser" ? (
          <p>{t(uiLanguage, "pwaIosBrowserInstruction")}</p>
        ) : model.canPromptInstall ? (
          <p>{t(uiLanguage, "pwaAndroidNativeDescription")}</p>
        ) : (
          <p>{t(uiLanguage, "pwaAndroidFallbackInstruction")}</p>
        )}
        {model.platform === "android" && model.canPromptInstall ? (
          <button
            type="button"
            class="pwa-install-prompt__action touch-target"
            onClick={() => {
              void model.promptInstall();
            }}
          >
            {t(uiLanguage, "pwaInstallNow")}
          </button>
        ) : null}
      </div>
      <button
        type="button"
        class="pwa-install-prompt__close touch-target"
        aria-label={t(uiLanguage, "pwaInstallClose")}
        onClick={model.dismiss}
      >
        ×
      </button>
    </aside>
  );
}
