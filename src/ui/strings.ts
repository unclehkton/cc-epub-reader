/**
 * Reader / library chrome strings.
 * Traditional Chinese is the source; Simplified is a hand-mapped display locale
 * (not book content conversion — that uses OpenCC `simplified` mode).
 */

import type { UiLanguage } from "../domain/types";

export type UiStringKey =
  | "libraryTitle"
  | "libraryPrivacy"
  | "importEpub"
  | "loading"
  | "settings"
  | "toc"
  | "close"
  | "closeSettings"
  | "fullscreen"
  | "exitFullscreen"
  | "prevPage"
  | "nextPage"
  | "readingSettings"
  | "fontSize"
  | "fontFamily"
  | "background"
  | "theme"
  | "readingMode"
  | "conversion"
  | "horizontalMargin"
  | "tocSide"
  | "uiLanguage"
  | "licenses"
  | "licensesTitle"
  | "licensesIntro"
  | "tocLeft"
  | "tocRight"
  | "langTraditional"
  | "langSimplified"
  | "backToLibrary"
  | "converting"
  | "sessionOnlyDefault";

const HANT: Record<UiStringKey, string> = {
  libraryTitle: "你的書庫",
  libraryPrivacy: "書籍只會儲存在此裝置",
  importEpub: "匯入 EPUB",
  loading: "載入中…",
  settings: "設定",
  toc: "目錄",
  close: "關閉",
  closeSettings: "關閉設定",
  fullscreen: "全螢幕",
  exitFullscreen: "結束全螢幕",
  prevPage: "上一頁",
  nextPage: "下一頁",
  readingSettings: "閱讀設定",
  fontSize: "文字大小",
  fontFamily: "字體",
  background: "背景",
  theme: "主題",
  readingMode: "閱讀模式",
  conversion: "字體轉換",
  horizontalMargin: "左右邊距",
  tocSide: "目錄位置",
  uiLanguage: "介面語言",
  licenses: "開放原始碼授權",
  licensesTitle: "授權與著作權聲明",
  licensesIntro:
    "本應用程式使用下列開放原始碼元件。以下為其授權與著作權聲明摘要；完整條款以各專案原始授權為準。",
  tocLeft: "左側",
  tocRight: "右側",
  langTraditional: "繁體中文",
  langSimplified: "簡體中文",
  backToLibrary: "返回書庫",
  converting: "轉換中…",
  sessionOnlyDefault:
    "目前無法使用持久儲存，書籍與進度只會保留在這個瀏覽階段，重新載入後會消失。",
};

const HANS: Record<UiStringKey, string> = {
  libraryTitle: "你的书库",
  libraryPrivacy: "书籍只会保存在此装置",
  importEpub: "导入 EPUB",
  loading: "加载中…",
  settings: "设置",
  toc: "目录",
  close: "关闭",
  closeSettings: "关闭设置",
  fullscreen: "全屏",
  exitFullscreen: "结束全屏",
  prevPage: "上一页",
  nextPage: "下一页",
  readingSettings: "阅读设置",
  fontSize: "文字大小",
  fontFamily: "字体",
  background: "背景",
  theme: "主题",
  readingMode: "阅读模式",
  conversion: "字体转换",
  horizontalMargin: "左右边距",
  tocSide: "目录位置",
  uiLanguage: "界面语言",
  licenses: "开源授权",
  licensesTitle: "授权与著作权声明",
  licensesIntro:
    "本应用程序使用下列开源组件。以下为其授权与著作权声明摘要；完整条款以各项目原始授权为准。",
  tocLeft: "左侧",
  tocRight: "右侧",
  langTraditional: "繁体中文",
  langSimplified: "简体中文",
  backToLibrary: "返回书库",
  converting: "转换中…",
  sessionOnlyDefault:
    "目前无法使用持久存储，书籍与进度只会保留在这个浏览阶段，重新加载后会消失。",
};

export function t(lang: UiLanguage | undefined, key: UiStringKey): string {
  const table = lang === "zh-Hans" ? HANS : HANT;
  return table[key];
}
