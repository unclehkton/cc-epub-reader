/**
 * Horizontal swipe detection for mobile page turns.
 * Pure helpers so unit tests can cover thresholds without DOM.
 */

export const SWIPE_MIN_DISTANCE_PX = 48;
export const SWIPE_MAX_VERTICAL_RATIO = 0.75;
export const SWIPE_MAX_DURATION_MS = 800;

export type SwipeDirection = "left" | "right" | null;

export interface SwipeSample {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  durationMs: number;
}

/**
 * Classify a touch path as a horizontal page-turn swipe.
 * Returns "left" (next page), "right" (previous), or null.
 */
export function classifySwipe(sample: SwipeSample): SwipeDirection {
  if (!Number.isFinite(sample.durationMs) || sample.durationMs > SWIPE_MAX_DURATION_MS) {
    return null;
  }
  if (sample.durationMs < 0) return null;

  const dx = sample.endX - sample.startX;
  const dy = sample.endY - sample.startY;
  const absX = Math.abs(dx);
  const absY = Math.abs(dy);

  if (absX < SWIPE_MIN_DISTANCE_PX) return null;
  if (absY > 0 && absX / absY < 1 / SWIPE_MAX_VERTICAL_RATIO) {
    // Too vertical relative to horizontal movement.
    if (absY >= absX * SWIPE_MAX_VERTICAL_RATIO && absY > absX) {
      return null;
    }
  }
  if (absY > absX) return null;

  return dx < 0 ? "left" : "right";
}
