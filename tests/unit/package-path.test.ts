import { describe, expect, it } from "vitest";
import {
  normalizePosixPath,
  packageDir,
  resolvePackagePath,
} from "../../src/reader/package-path";

describe("packageDir", () => {
  it("returns directory of section href", () => {
    expect(packageDir("OEBPS/Text/ch1.xhtml")).toBe("OEBPS/Text");
    expect(packageDir("ch1.xhtml")).toBe("");
  });
});

describe("resolvePackagePath", () => {
  it("resolves nested relative images", () => {
    expect(resolvePackagePath("Text/ch1.xhtml", "../Images/a.png")).toBe(
      "Images/a.png",
    );
    expect(resolvePackagePath("Text/sub/ch2.xhtml", "../../Images/a.png")).toBe(
      "Images/a.png",
    );
  });

  it("rejects archive-root escape", () => {
    expect(resolvePackagePath("Text/ch1.xhtml", "../../evil.png")).toBeNull();
    expect(resolvePackagePath("a/b/c.xhtml", "../../../x")).toBeNull();
  });

  it("rejects network and schemes", () => {
    expect(resolvePackagePath("Text/ch1.xhtml", "https://evil/x.css")).toBeNull();
    expect(resolvePackagePath("Text/ch1.xhtml", "//evil/x.css")).toBeNull();
    expect(resolvePackagePath("Text/ch1.xhtml", "javascript:alert(1)")).toBeNull();
  });

  it("rejects backslash confusion", () => {
    expect(resolvePackagePath("Text/ch1.xhtml", "..\\Images\\a.png")).toBe(
      "Images/a.png",
    );
  });

  it("strips query and fragment", () => {
    expect(resolvePackagePath("Text/ch1.xhtml", "../Images/a.png?x=1#y")).toBe(
      "Images/a.png",
    );
  });

  it("decodes percent-encoded segments", () => {
    expect(
      resolvePackagePath("Text/ch1.xhtml", "../Images/%E4%B8%AD.png"),
    ).toBe("Images/中.png");
  });
});

describe("normalizePosixPath", () => {
  it("collapses dots", () => {
    expect(normalizePosixPath("a/./b/../c")).toBe("a/c");
  });
});
