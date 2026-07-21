import type { ConversionMode, StoredSettings } from "../domain/types";

export interface SettingsSheetProps {
  open: boolean;
  settings: StoredSettings;
  onChange: (next: StoredSettings) => void;
  onClose: () => void;
  conversionError?: string | null;
}

const CONVERSION_OPTIONS: Array<{ value: ConversionMode; label: string }> = [
  { value: "original", label: "原文" },
  { value: "traditional", label: "一般繁體" },
  { value: "hong-kong", label: "香港繁體" },
  { value: "taiwan", label: "台灣繁體" },
];

const FONT_FAMILY_OPTIONS: Array<{
  value: StoredSettings["fontFamily"];
  label: string;
}> = [
  { value: "book", label: "書本" },
  { value: "sans", label: "無襯線" },
  { value: "system", label: "系統" },
];

const BACKGROUND_OPTIONS: Array<{
  value: StoredSettings["background"];
  label: string;
}> = [
  { value: "rice", label: "米色" },
  { value: "white", label: "白色" },
  { value: "sepia", label: "復古" },
];

const THEME_OPTIONS: Array<{
  value: StoredSettings["theme"];
  label: string;
}> = [
  { value: "system", label: "跟隨系統" },
  { value: "day", label: "日間" },
  { value: "night", label: "夜間" },
];

const FLOW_OPTIONS: Array<{
  value: StoredSettings["flow"];
  label: string;
}> = [
  { value: "paginated", label: "分頁" },
  { value: "scrolled", label: "捲動" },
];

export function SettingsSheet({
  open,
  settings,
  onChange,
  onClose,
  conversionError = null,
}: SettingsSheetProps) {
  if (!open) {
    return null;
  }

  const patch = (partial: Partial<StoredSettings>) => {
    onChange({ ...settings, ...partial, key: "reader" });
  };

  return (
    <div class="settings-sheet-root">
      <button
        type="button"
        class="settings-backdrop"
        aria-label="關閉設定"
        onClick={onClose}
      />
      <div
        class="settings-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-sheet-title"
      >
        <div class="settings-sheet-header">
          <h2 id="settings-sheet-title" class="settings-sheet-title">
            閱讀設定
          </h2>
          <button
            type="button"
            class="settings-close touch-target"
            style={{ minWidth: "44px", minHeight: "44px" }}
            aria-label="關閉設定"
            onClick={onClose}
          >
            關閉
          </button>
        </div>

        <div class="settings-section">
          <h3 class="settings-section-title">文字大小</h3>
          <div class="settings-row">
            <button
              type="button"
              class="settings-chip touch-target"
              style={{ minWidth: "44px", minHeight: "44px" }}
              aria-label="縮小文字"
              onClick={() => {
                patch({
                  fontSizePercent: Math.max(80, settings.fontSizePercent - 10),
                });
              }}
            >
              A−
            </button>
            <span class="settings-value" aria-live="polite">
              {settings.fontSizePercent}%
            </span>
            <button
              type="button"
              class="settings-chip touch-target"
              style={{ minWidth: "44px", minHeight: "44px" }}
              aria-label="放大文字"
              onClick={() => {
                patch({
                  fontSizePercent: Math.min(200, settings.fontSizePercent + 10),
                });
              }}
            >
              A＋
            </button>
          </div>
        </div>

        <fieldset class="settings-section">
          <legend class="settings-section-title">字體</legend>
          <div class="settings-options" role="radiogroup" aria-label="字體">
            {FONT_FAMILY_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={settings.fontFamily === option.value}
                class={[
                  "settings-chip touch-target",
                  settings.fontFamily === option.value
                    ? "settings-chip--active"
                    : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                style={{ minWidth: "44px", minHeight: "44px" }}
                onClick={() => {
                  patch({ fontFamily: option.value });
                }}
              >
                {option.label}
              </button>
            ))}
          </div>
        </fieldset>

        <fieldset class="settings-section">
          <legend class="settings-section-title">背景</legend>
          <div class="settings-options" role="radiogroup" aria-label="背景">
            {BACKGROUND_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={settings.background === option.value}
                class={[
                  "settings-chip touch-target",
                  settings.background === option.value
                    ? "settings-chip--active"
                    : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                style={{ minWidth: "44px", minHeight: "44px" }}
                onClick={() => {
                  patch({ background: option.value });
                }}
              >
                {option.label}
              </button>
            ))}
          </div>
        </fieldset>

        <fieldset class="settings-section">
          <legend class="settings-section-title">主題</legend>
          <div class="settings-options" role="radiogroup" aria-label="主題">
            {THEME_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={settings.theme === option.value}
                class={[
                  "settings-chip touch-target",
                  settings.theme === option.value
                    ? "settings-chip--active"
                    : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                style={{ minWidth: "44px", minHeight: "44px" }}
                onClick={() => {
                  patch({ theme: option.value });
                }}
              >
                {option.label}
              </button>
            ))}
          </div>
        </fieldset>

        <fieldset class="settings-section">
          <legend class="settings-section-title">閱讀模式</legend>
          <div class="settings-options" role="radiogroup" aria-label="閱讀模式">
            {FLOW_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={settings.flow === option.value}
                class={[
                  "settings-chip touch-target",
                  settings.flow === option.value
                    ? "settings-chip--active"
                    : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                style={{ minWidth: "44px", minHeight: "44px" }}
                onClick={() => {
                  patch({ flow: option.value });
                }}
              >
                {option.label}
              </button>
            ))}
          </div>
        </fieldset>

        <fieldset class="settings-section">
          <legend class="settings-section-title">字體轉換</legend>
          <div
            class="settings-options settings-options--wrap"
            role="radiogroup"
            aria-label="字體轉換"
          >
            {CONVERSION_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={settings.conversion === option.value}
                class={[
                  "settings-chip touch-target",
                  settings.conversion === option.value
                    ? "settings-chip--active"
                    : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                style={{ minWidth: "44px", minHeight: "44px" }}
                onClick={() => {
                  patch({ conversion: option.value });
                }}
              >
                {option.label}
              </button>
            ))}
          </div>
          {conversionError ? (
            <p class="settings-error" role="alert">
              {conversionError}
            </p>
          ) : null}
        </fieldset>
      </div>
    </div>
  );
}
