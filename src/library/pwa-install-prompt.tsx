import type { PwaInstallPromptModel } from "../platform/use-pwa-install-prompt";

export interface PwaInstallPromptProps {
  model: PwaInstallPromptModel;
}

export function PwaInstallPrompt({ model }: PwaInstallPromptProps) {
  if (!model.visible || !model.platform) return null;

  const isIphone = model.platform === "iphone";
  return (
    <aside class="pwa-install-prompt" aria-labelledby="pwa-install-title">
      <span class="pwa-install-prompt__icon" aria-hidden="true">
        {isIphone ? "⇧" : "⌂"}
      </span>
      <div class="pwa-install-prompt__copy">
        <h2 id="pwa-install-title">將書庫加入主畫面</h2>
        {isIphone ? (
          <p>
            點擊 Safari 分享按鈕 <span aria-hidden="true">⇧</span>，再選擇
            「加入主畫面」。
          </p>
        ) : model.canPromptInstall ? (
          <p>安裝後可從主畫面直接開啟書庫，閱讀更方便。</p>
        ) : (
          <p>請開啟 Chrome 選單，選擇「安裝應用程式」或「加入主畫面」。</p>
        )}
        {model.platform === "android" && model.canPromptInstall ? (
          <button
            type="button"
            class="pwa-install-prompt__action touch-target"
            onClick={() => {
              void model.promptInstall();
            }}
          >
            立即安裝
          </button>
        ) : null}
      </div>
      <button
        type="button"
        class="pwa-install-prompt__close touch-target"
        aria-label="關閉安裝提示"
        onClick={model.dismiss}
      >
        ×
      </button>
    </aside>
  );
}
