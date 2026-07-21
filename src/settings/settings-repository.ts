/**
 * Reader appearance / conversion settings in IndexedDB `settings` store.
 */

import type { ConversionMode, StoredSettings } from "../domain/types";
import { openDatabase, requestToPromise, transactionDone } from "../library/idb";

export const DEFAULT_SETTINGS: StoredSettings = {
  key: "reader",
  flow: "paginated",
  conversion: "original",
  fontSizePercent: 100,
  fontFamily: "book",
  background: "rice",
  theme: "system",
};

const SETTINGS_KEY = "reader" as const;

const FLOWS = new Set<StoredSettings["flow"]>(["paginated", "scrolled"]);
const CONVERSIONS = new Set<ConversionMode>([
  "original",
  "traditional",
  "hong-kong",
  "taiwan",
]);
const FONT_FAMILIES = new Set<StoredSettings["fontFamily"]>([
  "book",
  "sans",
  "system",
]);
const BACKGROUNDS = new Set<StoredSettings["background"]>([
  "rice",
  "white",
  "sepia",
]);
const THEMES = new Set<StoredSettings["theme"]>(["system", "day", "night"]);

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Validate and normalise a settings record; returns defaults when invalid. */
export function parseStoredSettings(value: unknown): StoredSettings {
  if (value === null || typeof value !== "object") {
    return { ...DEFAULT_SETTINGS };
  }

  const record = value as Record<string, unknown>;
  const flow =
    typeof record.flow === "string" && FLOWS.has(record.flow as StoredSettings["flow"])
      ? (record.flow as StoredSettings["flow"])
      : DEFAULT_SETTINGS.flow;
  const conversion =
    typeof record.conversion === "string" &&
    CONVERSIONS.has(record.conversion as ConversionMode)
      ? (record.conversion as ConversionMode)
      : DEFAULT_SETTINGS.conversion;
  const fontFamily =
    typeof record.fontFamily === "string" &&
    FONT_FAMILIES.has(record.fontFamily as StoredSettings["fontFamily"])
      ? (record.fontFamily as StoredSettings["fontFamily"])
      : DEFAULT_SETTINGS.fontFamily;
  const background =
    typeof record.background === "string" &&
    BACKGROUNDS.has(record.background as StoredSettings["background"])
      ? (record.background as StoredSettings["background"])
      : DEFAULT_SETTINGS.background;
  const theme =
    typeof record.theme === "string" &&
    THEMES.has(record.theme as StoredSettings["theme"])
      ? (record.theme as StoredSettings["theme"])
      : DEFAULT_SETTINGS.theme;

  let fontSizePercent = DEFAULT_SETTINGS.fontSizePercent;
  if (isFiniteNumber(record.fontSizePercent)) {
    fontSizePercent = Math.max(80, Math.min(200, Math.round(record.fontSizePercent)));
  }

  return {
    key: SETTINGS_KEY,
    flow,
    conversion,
    fontSizePercent,
    fontFamily,
    background,
    theme,
  };
}

export interface SettingsRepositoryLike {
  get(): Promise<StoredSettings>;
  save(settings: StoredSettings): Promise<void>;
}

export class SettingsRepository implements SettingsRepositoryLike {
  private async withDb<T>(fn: (db: IDBDatabase) => Promise<T>): Promise<T> {
    const db = await openDatabase();
    try {
      return await fn(db);
    } finally {
      db.close();
    }
  }

  async get(): Promise<StoredSettings> {
    try {
      return await this.withDb(async (db) => {
        const tx = db.transaction("settings", "readonly");
        const done = transactionDone(tx);
        const raw = await requestToPromise(
          tx.objectStore("settings").get(SETTINGS_KEY),
        );
        await done;
        return parseStoredSettings(raw);
      });
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  async save(settings: StoredSettings): Promise<void> {
    const normalised = parseStoredSettings(settings);
    await this.withDb(async (db) => {
      const tx = db.transaction("settings", "readwrite");
      const done = transactionDone(tx);
      const put = requestToPromise(tx.objectStore("settings").put(normalised));
      await Promise.all([put, done]);
    });
  }
}
