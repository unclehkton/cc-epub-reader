import { describe, expect, it } from "vitest";
import {
  isPackageStylesheetHref,
  sanitizePackageCss,
} from "../../src/reader/css-sanitize";

describe("sanitizePackageCss", () => {
  it("removes @import", () => {
    const out = sanitizePackageCss('@import url("https://evil/x.css"); p{color:red}');
    expect(out).not.toMatch(/@import/i);
    expect(out).toMatch(/color:\s*red/);
  });

  it("blocks remote url()", () => {
    const out = sanitizePackageCss(
      'p{background:url(https://evil/a.png)} h1{color:blue}',
    );
    expect(out).not.toMatch(/https?:\/\//i);
    expect(out).toMatch(/color:\s*blue/);
  });

  it("blocks javascript urls", () => {
    const out = sanitizePackageCss("p{background:url(javascript:alert(1))}");
    expect(out.toLowerCase()).not.toMatch(/javascript:/);
  });

  it("preserves safe layout declarations", () => {
    const src = `
      h1 { font-size: 1.5em; margin: 0 0 1em; }
      p { text-indent: 2em; line-height: 1.6; }
      .poem { white-space: pre-wrap; text-align: center; }
    `;
    const out = sanitizePackageCss(src);
    expect(out).toMatch(/text-indent/);
    expect(out).toMatch(/white-space:\s*pre-wrap/);
  });

  it("neutralizes package-relative url() so images cannot auto-fetch", () => {
    const out = sanitizePackageCss(
      "div{background:url(../Images/cover.png)} p{color:red}",
    );
    expect(out).not.toMatch(/Images\/cover/i);
    expect(out).toMatch(/about:blank|url\(\s*\)/);
    expect(out).toMatch(/color:\s*red/);
  });

  it("allows only blob and safe data urls", () => {
    const out = sanitizePackageCss(
      "div{background:url(blob:https://x/1)} span{background:url(data:image/png;base64,aa)}",
    );
    expect(out).toMatch(/blob:/);
    expect(out).toMatch(/data:image\/png/);
  });
});

describe("isPackageStylesheetHref", () => {
  it("accepts relative hrefs", () => {
    expect(isPackageStylesheetHref("../Styles/main.css")).toBe(true);
  });
  it("rejects remote hrefs", () => {
    expect(isPackageStylesheetHref("https://cdn.example/a.css")).toBe(false);
  });
});
