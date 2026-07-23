import { describe, expect, it } from "vitest";
import {
  SWIPE_MIN_DISTANCE_PX,
  classifySwipe,
} from "../../src/reader/swipe";

describe("classifySwipe", () => {
  it("detects left swipe as next-page gesture", () => {
    expect(
      classifySwipe({
        startX: 200,
        startY: 100,
        endX: 200 - SWIPE_MIN_DISTANCE_PX - 10,
        endY: 105,
        durationMs: 200,
      }),
    ).toBe("left");
  });

  it("detects right swipe as previous-page gesture", () => {
    expect(
      classifySwipe({
        startX: 40,
        startY: 100,
        endX: 40 + SWIPE_MIN_DISTANCE_PX + 10,
        endY: 98,
        durationMs: 180,
      }),
    ).toBe("right");
  });

  it("ignores short or vertical movements", () => {
    expect(
      classifySwipe({
        startX: 100,
        startY: 100,
        endX: 120,
        endY: 102,
        durationMs: 100,
      }),
    ).toBeNull();

    expect(
      classifySwipe({
        startX: 100,
        startY: 50,
        endX: 110,
        endY: 200,
        durationMs: 200,
      }),
    ).toBeNull();
  });

  it("ignores slow long drags past duration cap", () => {
    expect(
      classifySwipe({
        startX: 200,
        startY: 100,
        endX: 40,
        endY: 100,
        durationMs: 2000,
      }),
    ).toBeNull();
  });

  it("enforces max vertical ratio at the 75% boundary", () => {
    const horizontal = 100;
    // 74% vertical → accept
    expect(
      classifySwipe({
        startX: 200,
        startY: 100,
        endX: 200 - horizontal,
        endY: 100 + Math.floor(horizontal * 0.74),
        durationMs: 200,
      }),
    ).toBe("left");
    // exactly 75% → accept (not greater than)
    expect(
      classifySwipe({
        startX: 200,
        startY: 100,
        endX: 200 - horizontal,
        endY: 100 + horizontal * 0.75,
        durationMs: 200,
      }),
    ).toBe("left");
    // 76% → reject
    expect(
      classifySwipe({
        startX: 200,
        startY: 100,
        endX: 200 - horizontal,
        endY: 100 + Math.ceil(horizontal * 0.76),
        durationMs: 200,
      }),
    ).toBeNull();
  });
});
