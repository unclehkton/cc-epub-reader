import { describe, expect, it } from "vitest";
import {
  classifyTransition,
  locationMeaningfullyChanged,
  type LocationLike,
} from "../../src/reader/location-transition";

function loc(partial: Partial<LocationLike>): LocationLike {
  return {
    cfi: "cfi-a",
    spineHref: "ch1.xhtml",
    spineIndex: 0,
    chapterPage: 1,
    chapterPages: 10,
    ...partial,
  };
}

describe("locationMeaningfullyChanged", () => {
  it("detects same-spine page change", () => {
    expect(
      locationMeaningfullyChanged(
        loc({ chapterPage: 1, cfi: "a" }),
        loc({ chapterPage: 2, cfi: "b" }),
      ),
    ).toBe(true);
  });

  it("rejects identical location", () => {
    const a = loc({});
    expect(locationMeaningfullyChanged(a, { ...a })).toBe(false);
  });
});

describe("classifyTransition", () => {
  const docA = {} as Document;
  const docB = {} as Document;

  it("classifies same-spine same document", () => {
    const kind = classifyTransition(
      {
        location: loc({ chapterPage: 1, cfi: "a" }),
        document: docA,
        renderEpoch: 0,
        cfi: "a",
        spineIndex: 0,
        spineHref: "ch1.xhtml",
      },
      {
        location: loc({ chapterPage: 2, cfi: "b" }),
        document: docA,
        renderEpoch: 0,
        cfi: "b",
        spineIndex: 0,
        spineHref: "ch1.xhtml",
      },
    );
    expect(kind).toBe("same-spine-same-document");
  });

  it("classifies cross-spine", () => {
    const kind = classifyTransition(
      {
        location: loc({ spineIndex: 0, spineHref: "ch1.xhtml" }),
        document: docA,
        renderEpoch: 0,
        cfi: "a",
        spineIndex: 0,
        spineHref: "ch1.xhtml",
      },
      {
        location: loc({
          spineIndex: 1,
          spineHref: "ch2.xhtml",
          cfi: "c",
        }),
        document: docB,
        renderEpoch: 1,
        cfi: "c",
        spineIndex: 1,
        spineHref: "ch2.xhtml",
      },
    );
    expect(kind).toBe("cross-spine");
  });

  it("classifies same-spine replaced document on location change", () => {
    const kind = classifyTransition(
      {
        location: loc({ chapterPage: 1, cfi: "a" }),
        document: docA,
        renderEpoch: 0,
        cfi: "a",
        spineIndex: 0,
        spineHref: "ch1.xhtml",
      },
      {
        location: loc({ chapterPage: 2, cfi: "b" }),
        document: docB,
        renderEpoch: 1,
        cfi: "b",
        spineIndex: 0,
        spineHref: "ch1.xhtml",
      },
    );
    expect(kind).toBe("same-spine-replaced-document");
  });
});
