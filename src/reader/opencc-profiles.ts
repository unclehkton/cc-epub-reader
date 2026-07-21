import type { ConversionMode } from "../domain/types";

/** Modes that require an OpenCC profile (everything except `original`). */
export type ConvertibleMode = Exclude<ConversionMode, "original">;

export type OpenCCConverter = (text: string) => string;

/**
 * Locale options for opencc-js 1.4.1 `Converter({ from, to })`.
 * Maps product modes to OpenCC configs:
 * - traditional → s2t  (`cn` → `t`)
 * - hong-kong   → s2hk (`cn` → `hk`)
 * - taiwan      → s2twp (`cn` → `twp`, phrase conversion)
 */
export const PROFILE_OPTIONS: Record<ConvertibleMode, { from: string; to: string }> = {
  traditional: { from: "cn", to: "t" },
  "hong-kong": { from: "cn", to: "hk" },
  taiwan: { from: "cn", to: "twp" },
};

const converterCache = new Map<ConvertibleMode, OpenCCConverter>();

/**
 * Lazily load opencc-js and return a cached converter for the mode.
 */
export async function loadConverter(mode: ConvertibleMode): Promise<OpenCCConverter> {
  const cached = converterCache.get(mode);
  if (cached) {
    return cached;
  }

  const OpenCC = (await import("opencc-js")).default;
  const options = PROFILE_OPTIONS[mode];
  const converter = OpenCC.Converter(options);
  converterCache.set(mode, converter);
  return converter;
}

/** Test / teardown helper — clears the module-level converter cache. */
export function clearConverterCache(): void {
  converterCache.clear();
}
