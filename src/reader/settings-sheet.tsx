import type { ConversionMode, StoredSettings, UiLanguage } from "../domain/types";
import { t } from "../ui/strings";

export interface SettingsSheetProps {
  open: boolean;
  settings: StoredSettings;
  onChange: (next: StoredSettings) => void;
  onClose: () => void;
  conversionError?: string | null;
  onOpenLicenses?: () => void;
}

const CONVERSION_OPTIONS: Array<{ value: ConversionMode; labelKey: "original" | "traditional" | "hong-kong" | "taiwan" | "simplified" }> = [
  { value: "original", labelKey: "original" },
  { value: "traditional", labelKey: "traditional" },
  { value: "hong-kong", labelKey: "hong-kong" },
  { value: "taiwan", labelKey: "taiwan" },
  { value: "simplified", labelKey: "simplified" },
];

function conversionLabel(mode: ConversionMode, lang: UiLanguage | undefined): string {
  const hant: Record<ConversionMode, string> = {
    original: "原文",
    traditional: "一般繁體",
    "hong-kong": "香港繁體",
    taiwan: "台灣繁體",
    simplified: "簡體（繁→簡）",
  };
  const hans: Record<ConversionMode, string> = {
    original: "原文",
    traditional: "一般繁体",
    "hong-kong": "香港繁体",
    taiwan: "台湾繁体",
    simplified: "简体（繁→简）",
  };
  return (lang === "zh-Hans" ? hans : hant)[mode];
}

const FONT_FAMILY_OPTIONS: Array<{
  value: StoredSettings["fontFamily"];
  hant: string;
  hans: string;
}> = [
  { value: "book", hant: "書本", hans: "书本" },
  { value: "sans", hant: "無襯線", hans: "无衬线" },
  { value: "system", hant: "系統", hans: "系统" },
];

const BACKGROUND_OPTIONS: Array<{
  value: StoredSettings["background"];
  hant: string;
  hans: string;
}> = [
  { value: "rice", hant: "米色", hans: "米色" },
  { value: "white", hant: "白色", hans: "白色" },
  { value: "sepia", hant: "復古", hans: "复古" },
];

const THEME_OPTIONS: Array<{
  value: StoredSettings["theme"];
  hant: string;
  hans: string;
}> = [
  { value: "system", hant: "跟隨系統", hans: "跟随系统" },
  { value: "day", hant: "日間", hans: "日间" },
  { value: "night", hant: "夜間", hans: "夜间" },
];

const FLOW_OPTIONS: Array<{
  value: StoredSettings["flow"];
  hant: string;
  hans: string;
}> = [
  { value: "paginated", hant: "分頁", hans: "分页" },
  { value: "scrolled", hant: "捲動", hans: "滚动" },
];

export function SettingsSheet({
  open,
  settings,
  onChange,
  onClose,
  conversionError = null,
  onOpenLicenses,
}: SettingsSheetProps) {
  if (!open) {
    return null;
  }

  const lang = settings.uiLanguage ?? "zh-Hant";
  const label = (hant: string, hans: string) =>
    lang === "zh-Hans" ? hans : hant;

  const patch = (partial: Partial<StoredSettings>) => {
    onChange({ ...settings, ...partial, key: "reader" });
  };

  const margin = settings.horizontalMarginPercent ?? 4;

  return (
    <div class="settings-sheet-root">
      <button
        type="button"
        class="settings-backdrop"
        aria-label={t(lang, "closeSettings")}
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
            {t(lang, "readingSettings")}
          </h2>
          <button
            type="button"
            class="settings-close touch-target"
            style={{ minWidth: "44px", minHeight: "44px" }}
            aria-label={t(lang, "closeSettings")}
            onClick={onClose}
          >
            {t(lang, "close")}
          </button>
        </div>

        <div class="settings-section">
          <h3 class="settings-section-title">{t(lang, "fontSize")}</h3>
          <div class="settings-row">
            <button
              type="button"
              class="settings-chip touch-target"
              style={{ minWidth: "44px", minHeight: "44px" }}
              aria-label={lang === "zh-Hans" ? "缩小文字" : "縮小文字"}
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
              aria-label={lang === "zh-Hans" ? "放大文字" : "放大文字"}
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

        <div class="settings-section">
          <h3 class="settings-section-title">{t(lang, "horizontalMargin")}</h3>
          <div class="settings-row">
            <button
              type="button"
              class="settings-chip touch-target"
              style={{ minWidth: "44px", minHeight: "44px" }}
              aria-label="−"
              onClick={() => {
                patch({
                  horizontalMarginPercent: Math.max(0, margin - 2),
                });
              }}
            >
              −
            </button>
            <span class="settings-value" aria-live="polite">
              {margin}%
            </span>
            <button
              type="button"
              class="settings-chip touch-target"
              style={{ minWidth: "44px", minHeight: "44px" }}
              aria-label="＋"
              onClick={() => {
                patch({
                  horizontalMarginPercent: Math.min(20, margin + 2),
                });
              }}
            >
              ＋
            </button>
          </div>
        </div>

        <fieldset class="settings-section">
          <legend class="settings-section-title">{t(lang, "fontFamily")}</legend>
          <div class="settings-options" role="radiogroup" aria-label={t(lang, "fontFamily")}>
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
                {label(option.hant, option.hans)}
              </button>
            ))}
          </div>
        </fieldset>

        <fieldset class="settings-section">
          <legend class="settings-section-title">{t(lang, "background")}</legend>
          <div class="settings-options" role="radiogroup" aria-label={t(lang, "background")}>
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
                {label(option.hant, option.hans)}
              </button>
            ))}
          </div>
        </fieldset>

        <fieldset class="settings-section">
          <legend class="settings-section-title">{t(lang, "theme")}</legend>
          <div class="settings-options" role="radiogroup" aria-label={t(lang, "theme")}>
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
                {label(option.hant, option.hans)}
              </button>
            ))}
          </div>
        </fieldset>

        <fieldset class="settings-section">
          <legend class="settings-section-title">{t(lang, "readingMode")}</legend>
          <div class="settings-options" role="radiogroup" aria-label={t(lang, "readingMode")}>
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
                {label(option.hant, option.hans)}
              </button>
            ))}
          </div>
        </fieldset>

        <fieldset class="settings-section">
          <legend class="settings-section-title">{t(lang, "conversion")}</legend>
          <div
            class="settings-options settings-options--wrap"
            role="radiogroup"
            aria-label={t(lang, "conversion")}
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
                {conversionLabel(option.value, lang)}
              </button>
            ))}
          </div>
          {conversionError ? (
            <p class="settings-error" role="alert">
              {conversionError}
            </p>
          ) : null}
        </fieldset>

        <fieldset class="settings-section">
          <legend class="settings-section-title">{t(lang, "tocSide")}</legend>
          <div class="settings-options" role="radiogroup" aria-label={t(lang, "tocSide")}>
            <button
              type="button"
              role="radio"
              aria-checked={(settings.tocSide ?? "left") === "left"}
              class={[
                "settings-chip touch-target",
                (settings.tocSide ?? "left") === "left"
                  ? "settings-chip--active"
                  : "",
              ]
                .filter(Boolean)
                .join(" ")}
              style={{ minWidth: "44px", minHeight: "44px" }}
              onClick={() => {
                patch({ tocSide: "left" });
              }}
            >
              {t(lang, "tocLeft")}
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={settings.tocSide === "right"}
              class={[
                "settings-chip touch-target",
                settings.tocSide === "right" ? "settings-chip--active" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              style={{ minWidth: "44px", minHeight: "44px" }}
              onClick={() => {
                patch({ tocSide: "right" });
              }}
            >
              {t(lang, "tocRight")}
            </button>
          </div>
        </fieldset>

        <fieldset class="settings-section">
          <legend class="settings-section-title">{t(lang, "uiLanguage")}</legend>
          <div class="settings-options" role="radiogroup" aria-label={t(lang, "uiLanguage")}>
            <button
              type="button"
              role="radio"
              aria-checked={(settings.uiLanguage ?? "zh-Hant") === "zh-Hant"}
              class={[
                "settings-chip touch-target",
                (settings.uiLanguage ?? "zh-Hant") === "zh-Hant"
                  ? "settings-chip--active"
                  : "",
              ]
                .filter(Boolean)
                .join(" ")}
              style={{ minWidth: "44px", minHeight: "44px" }}
              onClick={() => {
                patch({ uiLanguage: "zh-Hant" });
              }}
            >
              {t(lang, "langTraditional")}
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={settings.uiLanguage === "zh-Hans"}
              class={[
                "settings-chip touch-target",
                settings.uiLanguage === "zh-Hans"
                  ? "settings-chip--active"
                  : "",
              ]
                .filter(Boolean)
                .join(" ")}
              style={{ minWidth: "44px", minHeight: "44px" }}
              onClick={() => {
                patch({ uiLanguage: "zh-Hans" });
              }}
            >
              {t(lang, "langSimplified")}
            </button>
          </div>
        </fieldset>

        {onOpenLicenses ? (
          <div class="settings-section">
            <button
              type="button"
              class="settings-chip touch-target settings-link-chip"
              style={{ minWidth: "44px", minHeight: "44px" }}
              onClick={onOpenLicenses}
            >
              {t(lang, "licenses")}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
