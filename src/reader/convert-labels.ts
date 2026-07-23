/**
 * Convert short UI labels (TOC entries, etc.) with the active OpenCC profile.
 */

import type { ConversionMode } from "../domain/types";
import { loadConverter } from "./opencc-profiles";

export async function convertLabels(
  labels: string[],
  mode: ConversionMode,
): Promise<string[]> {
  if (mode === "original" || labels.length === 0) {
    return labels.slice();
  }
  try {
    const convert = await loadConverter(mode);
    return labels.map((label) => convert(label));
  } catch {
    return labels.slice();
  }
}

export async function convertLabel(
  label: string,
  mode: ConversionMode,
): Promise<string> {
  const [out] = await convertLabels([label], mode);
  return out ?? label;
}
