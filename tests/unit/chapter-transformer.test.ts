import { describe, expect, it, vi } from "vitest";
import {
  injectPackageStylesheets,
  type ArchiveResolver,
  transformChapter,
} from "../../src/reader/chapter-transformer";
import { MAX_STYLESHEETS_PER_CHAPTER } from "../../src/reader/css-sanitize";
import { isRejectedUrl, resolveArchiveCandidate } from "../../src/reader/archive-url";

function parseHtml(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

/** Resolver that only accepts relative archive paths under images/ or OEBPS/. */
const localResolver: ArchiveResolver = (raw) => {
  if (raw.startsWith("images/") || raw.startsWith("OEBPS/")) {
    return `blob:archive/${raw}`;
  }
  return null;
};

describe("archive-url helpers", () => {
  it("rejects http, https, protocol-relative, javascript, and malformed values", () => {
    expect(isRejectedUrl("http://evil.example/a.png")).toBe(true);
    expect(isRejectedUrl("https://evil.example/a.png")).toBe(true);
    expect(isRejectedUrl("//evil.example/a.png")).toBe(true);
    expect(isRejectedUrl("javascript:alert(1)")).toBe(true);
    expect(isRejectedUrl("JAVASCRIPT:alert(1)")).toBe(true);
    expect(isRejectedUrl("")).toBe(true);
    expect(isRejectedUrl("   ")).toBe(true);
    expect(isRejectedUrl("http://")).toBe(true);
  });

  it("allows relative archive candidates to reach the resolver", () => {
    expect(isRejectedUrl("images/cover.png")).toBe(false);
    expect(isRejectedUrl("./images/cover.png")).toBe(false);
    expect(isRejectedUrl("../images/cover.png")).toBe(false);
  });

  it("never returns a value when the resolver rejects or the URL is unsafe", () => {
    expect(resolveArchiveCandidate("https://x.test/a.png", () => "blob:nope")).toBeNull();
    expect(resolveArchiveCandidate("images/a.png", () => null)).toBeNull();
    expect(resolveArchiveCandidate("images/a.png", (c) => `blob:${c}`)).toBe(
      "blob:images/a.png",
    );
  });
});

describe("transformChapter sanitizer", () => {
  it("removes hostile active content elements", () => {
    const doc = parseHtml(`<!DOCTYPE html><html><head>
      <base href="https://evil.example/">
      <meta http-equiv="refresh" content="0;url=https://evil.example/">
      <link rel="stylesheet" href="https://evil.example/x.css">
    </head><body>
      <script>window.pwned=1</script>
      <iframe src="https://evil.example/" srcdoc="<script>1</script>"></iframe>
      <object data="https://evil.example/x"></object>
      <embed src="https://evil.example/x">
      <form action="https://evil.example/"><input name="q"></form>
      <p>safe text</p>
      <svg xmlns="http://www.w3.org/2000/svg">
        <animate attributeName="x" values="0;1" />
        <animateTransform attributeName="transform" type="scale" />
        <set attributeName="visibility" to="hidden" />
        <foreignObject width="100" height="100"><body xmlns="http://www.w3.org/1999/xhtml"><script>1</script></body></foreignObject>
      </svg>
    </body></html>`);

    transformChapter(doc, localResolver);

    expect(doc.querySelector("script")).toBeNull();
    expect(doc.querySelector("iframe")).toBeNull();
    expect(doc.querySelector("object")).toBeNull();
    expect(doc.querySelector("embed")).toBeNull();
    expect(doc.querySelector("form")).toBeNull();
    expect(doc.querySelector("base")).toBeNull();
    expect(doc.querySelector('meta[http-equiv="refresh" i]')).toBeNull();
    expect(doc.querySelector("animate")).toBeNull();
    expect(doc.querySelector("animateTransform")).toBeNull();
    expect(doc.querySelector("set")).toBeNull();
    expect(doc.querySelector("foreignObject")).toBeNull();
    expect(doc.body.textContent).toContain("safe text");
  });

  it("removes uppercase SCRIPT and media fetchers in XHTML documents", () => {
    const xhtml = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
  <head><title>x</title>
    <style>@import url("https://evil.example/a.css"); p { background: url(https://evil.example/b.png); }</style>
    <link rel="prefetch" href="https://evil.example/x"/>
  </head>
  <body>
    <SCRIPT type="text/javascript">window.pwned=1</SCRIPT>
    <IMG src="https://evil.example/x.png" alt="x"/>
    <video src="https://evil.example/v.mp4"></video>
    <audio src="https://evil.example/a.mp3"></audio>
    <p style="background:url(https://evil.example/c.png)">ok</p>
    <a href="https://example.com/out">out</a>
  </body>
</html>`;
    const doc = new DOMParser().parseFromString(xhtml, "application/xhtml+xml");
    transformChapter(doc, localResolver);

    expect(doc.getElementsByTagName("script").length).toBe(0);
    expect(doc.getElementsByTagName("SCRIPT").length).toBe(0);
    expect(doc.getElementsByTagName("video").length).toBe(0);
    expect(doc.getElementsByTagName("audio").length).toBe(0);
    // Uppercase IMG must not keep a live network src.
    for (const img of Array.from(doc.getElementsByTagName("img"))) {
      expect(img.getAttribute("src")).toBeNull();
    }
    expect(doc.getElementsByTagName("link").length).toBe(0);
    const styleText = doc.getElementsByTagName("style")[0]?.textContent ?? "";
    expect(styleText.toLowerCase()).not.toContain("@import");
    expect(styleText.toLowerCase()).not.toContain("https://evil.example");
    const p = doc.getElementsByTagName("p")[0]!;
    expect(p.getAttribute("style") ?? "").not.toMatch(/https?:/i);
    const a = doc.getElementsByTagName("a")[0]!;
    expect(a.getAttribute("rel")).toContain("noopener");
    expect(a.getAttribute("target")).toBe("_blank");
    const csp = Array.from(doc.getElementsByTagName("meta")).find(
      (m) =>
        (m.getAttribute("http-equiv") || "").toLowerCase() ===
        "content-security-policy",
    );
    expect(csp?.getAttribute("content") || "").toContain("script-src 'none'");
  });

  it("strips inline event handlers and javascript: links", () => {
    const doc = parseHtml(`<!DOCTYPE html><html><body>
      <p onclick="alert(1)" onmouseover="alert(2)">text</p>
      <a href="javascript:alert(1)">js link</a>
      <a href="HTTPS://example.com/ok">https link</a>
      <img src="images/a.png" onerror="alert(1)" alt="x">
    </body></html>`);

    transformChapter(doc, localResolver);

    const p = doc.querySelector("p")!;
    expect(p.getAttribute("onclick")).toBeNull();
    expect(p.getAttribute("onmouseover")).toBeNull();
    for (const attr of Array.from(p.attributes)) {
      expect(attr.name.toLowerCase().startsWith("on")).toBe(false);
    }

    const jsLink = Array.from(doc.querySelectorAll("a")).find((a) =>
      (a.textContent || "").includes("js link"),
    )!;
    const href = (jsLink.getAttribute("href") || "").toLowerCase();
    expect(href.startsWith("javascript:")).toBe(false);

    const img = doc.querySelector("img")!;
    expect(img.getAttribute("onerror")).toBeNull();
  });

  it("removes or neutralizes remote stylesheets", () => {
    const doc = parseHtml(`<!DOCTYPE html><html><head>
      <link rel="stylesheet" href="https://cdn.example/x.css">
      <link rel="stylesheet" href="//cdn.example/y.css">
      <link rel="stylesheet" href="styles/local.css">
    </head><body></body></html>`);

    transformChapter(doc, (raw) => {
      if (raw === "styles/local.css" || raw.endsWith("styles/local.css")) {
        return raw;
      }
      return null;
    });

    const hrefs = Array.from(doc.querySelectorAll("link[rel~='stylesheet' i]")).map((el) =>
      el.getAttribute("href"),
    );
    expect(hrefs.every((h) => h === null || !/^https?:/i.test(h) && !h.startsWith("//"))).toBe(
      true,
    );
    // Remote links should be gone or have no href; local may remain.
    const remoteStillLive = Array.from(doc.querySelectorAll("link")).some((el) => {
      const h = el.getAttribute("href") || "";
      return /^https?:/i.test(h) || h.startsWith("//");
    });
    expect(remoteStillLive).toBe(false);
  });

  it("makes remote images inert and non-restorable", () => {
    const doc = parseHtml(`<!DOCTYPE html><html><body>
      <img src="https://evil.example/remote.png" alt="remote">
      <img src="//evil.example/proto.png" alt="proto">
      <img src="javascript:alert(1)" alt="js">
    </body></html>`);

    transformChapter(doc, localResolver);

    for (const img of Array.from(doc.querySelectorAll("img"))) {
      expect(img.getAttribute("src")).toBeNull();
      expect(img.getAttribute("srcset")).toBeNull();
      expect(img.getAttribute("data-epub-src")).toBeNull();
      expect(img.getAttribute("data-epub-srcset")).toBeNull();
    }
    // No reveal buttons for non-archive images.
    expect(doc.querySelectorAll('button[type="button"]').length).toBe(0);
  });

  it("gates archive-local images behind an accessible button with no real src", () => {
    const doc = parseHtml(`<!DOCTYPE html><html><body>
      <img src="images/cover.png" alt="封面">
    </body></html>`);

    transformChapter(doc, localResolver);

    const img = doc.querySelector("img")!;
    expect(img.getAttribute("src")).toBeNull();
    expect(img.getAttribute("srcset")).toBeNull();
    expect(img.getAttribute("data-epub-src")).toBe("blob:archive/images/cover.png");

    const button = doc.querySelector("button")!;
    expect(button.getAttribute("type")).toBe("button");
    expect(button.textContent?.trim()).toBe("點擊顯示圖片");
    expect(button.getAttribute("aria-label") || button.textContent?.trim()).toContain(
      "點擊顯示圖片",
    );
    // Reserve layout so parent overlays can target unrevealed images.
    expect(img.style.minWidth || img.getAttribute("width")).toBeTruthy();
  });

  it("associates gate failure text only with the clicked image among siblings", async () => {
    const doc = parseHtml(`<!DOCTYPE html><html><body>
      <div>
        <img src="images/a.png" alt="a">
        <img src="images/b.png" alt="b">
      </div>
    </body></html>`);

    // Use package-relative paths so materialize is required (not pre-resolved blob).
    const resolver: ArchiveResolver = (raw) => {
      if (raw.startsWith("images/")) return raw;
      return null;
    };

    const result = transformChapter(doc, resolver, {
      materializeArchiveUrl: async (path) => {
        if (path.includes("b.png")) return null;
        return `blob:ok/${path}`;
      },
    });

    const imgs = Array.from(doc.querySelectorAll("img"));
    expect(imgs).toHaveLength(2);
    const btnA = imgs[0]!.previousElementSibling as HTMLButtonElement;
    const btnB = imgs[1]!.previousElementSibling as HTMLButtonElement;
    expect(btnA.textContent).toContain("點擊顯示圖片");
    expect(btnB.textContent).toContain("點擊顯示圖片");

    btnB.click();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(btnB.textContent).toContain("圖片載入失敗");
    expect(btnA.textContent?.trim()).toBe("點擊顯示圖片");

    result.dispose();
  });

  it("stores srcset in data-epub-srcset and strips live srcset before activation", () => {
    const doc = parseHtml(`<!DOCTYPE html><html><body>
      <img src="images/a.png" srcset="images/a.png 1x, images/a@2x.png 2x" alt="a">
    </body></html>`);

    const resolver: ArchiveResolver = (raw) => {
      const base = raw.split(/\s+/)[0]!;
      if (base.startsWith("images/")) return `blob:archive/${base}`;
      return null;
    };

    transformChapter(doc, resolver);

    const img = doc.querySelector("img")!;
    expect(img.getAttribute("src")).toBeNull();
    expect(img.getAttribute("srcset")).toBeNull();
    expect(img.getAttribute("data-epub-src")).toBe("blob:archive/images/a.png");
    expect(img.getAttribute("data-epub-srcset")).toBeTruthy();
    expect(img.getAttribute("data-epub-srcset")).not.toMatch(/https?:/i);
  });

  it("neutralizes picture source elements and SVG images", () => {
    const doc = parseHtml(`<!DOCTYPE html><html><body>
      <picture>
        <source srcset="https://evil.example/x.png">
        <source srcset="images/local.png">
        <img src="images/fallback.png" alt="pic">
      </picture>
      <svg xmlns="http://www.w3.org/2000/svg">
        <image href="https://evil.example/r.svg" width="10" height="10" />
        <image href="images/icon.svg" width="10" height="10" />
      </svg>
    </body></html>`);

    transformChapter(doc, localResolver);

    for (const source of Array.from(doc.querySelectorAll("picture source"))) {
      expect(source.getAttribute("srcset")).toBeNull();
      expect(source.getAttribute("src")).toBeNull();
    }

    const svgImages = Array.from(doc.querySelectorAll("image"));
    for (const image of svgImages) {
      expect(image.getAttribute("href")).toBeNull();
      expect(image.getAttribute("xlink:href")).toBeNull();
      expect(image.getAttributeNS("http://www.w3.org/1999/xlink", "href")).toBeNull();
    }

    // Local svg image may store data-epub-src and get a gate.
    const localSvg = svgImages.find((el) => el.getAttribute("data-epub-src"));
    expect(localSvg?.getAttribute("data-epub-src")).toBe("blob:archive/images/icon.svg");
  });

  it("activation restores only the validated archive URL", () => {
    const doc = parseHtml(`<!DOCTYPE html><html><body>
      <img src="images/cover.png" alt="封面">
    </body></html>`);

    const result = transformChapter(doc, localResolver);
    const img = doc.querySelector("img")!;
    const button = doc.querySelector("button")!;

    expect(img.getAttribute("src")).toBeNull();
    button.click();
    expect(img.getAttribute("src")).toBe("blob:archive/images/cover.png");
    expect(img.getAttribute("src")).not.toMatch(/^https?:/i);
    expect(img.getAttribute("src")).not.toMatch(/^javascript:/i);

    result.dispose();
  });

  it("dispose removes reveal listeners so later clicks do nothing new", () => {
    const doc = parseHtml(`<!DOCTYPE html><html><body>
      <img src="images/cover.png" alt="封面">
    </body></html>`);

    const result = transformChapter(doc, localResolver);
    const img = doc.querySelector("img")!;
    const button = doc.querySelector("button")!;
    result.dispose();

    // Clear any src that might have been set; click after dispose must not re-apply.
    img.removeAttribute("src");
    button.click();
    expect(img.getAttribute("src")).toBeNull();
  });

  it("does not install a post-render secondary sanitizer export path", async () => {
    const mod = await import("../../src/reader/chapter-transformer");
    expect(typeof mod.transformChapter).toBe("function");
    // Only the pre-serialization path is public.
    expect("sanitizeAfterRender" in mod).toBe(false);
    expect("postRenderSanitize" in mod).toBe(false);
    expect("cleanupRenderedChapter" in mod).toBe(false);
  });

  it("limits stylesheet inject attempts (not only successes) to MAX", async () => {
    const links = Array.from({ length: MAX_STYLESHEETS_PER_CHAPTER + 8 }, (_, i) => {
      return `<link rel="stylesheet" data-epub-css="styles/s${i}.css">`;
    }).join("");
    const doc = parseHtml(`<!DOCTYPE html><html><head>${links}</head><body></body></html>`);

    let readCalls = 0;
    const readCss = vi.fn(async () => {
      readCalls += 1;
      return null;
    });

    await injectPackageStylesheets(doc, readCss);

    expect(readCalls).toBe(MAX_STYLESHEETS_PER_CHAPTER);
    expect(doc.querySelectorAll("link[data-epub-css]").length).toBe(0);
  });

  it("passes per-sheet maxBytes into bounded CSS reader (not createUrl)", async () => {
    const doc = parseHtml(
      `<!DOCTYPE html><html><head>
        <link rel="stylesheet" data-epub-css="styles/huge.css">
      </head><body></body></html>`,
    );
    const readCss = vi.fn(async (_path: string, maxBytes: number) => {
      expect(maxBytes).toBeLessThanOrEqual(256 * 1024);
      return null;
    });
    await injectPackageStylesheets(doc, readCss);
    expect(readCss).toHaveBeenCalled();
  });

  it("stops aggregate CSS at 512 KiB UTF-8 bytes", async () => {
    // Three ~200 KiB sheets should stop after the third attempt exceeds aggregate.
    const chunk = "a".repeat(200 * 1024);
    const links = Array.from({ length: 5 }, (_, i) => {
      return `<link rel="stylesheet" data-epub-css="styles/s${i}.css">`;
    }).join("");
    const doc = parseHtml(
      `<!DOCTYPE html><html><head>${links}</head><body></body></html>`,
    );
    let calls = 0;
    const readCss = vi.fn(async () => {
      calls += 1;
      return chunk;
    });
    await injectPackageStylesheets(doc, readCss);
    // First two fit (400 KiB); third may load then reject on aggregate, or
    // room for third is 112 KiB so maxBytes is capped and reader returns null
    // depending on mock — mock always returns 200 KiB so third is dropped after
    // byte check. Ensure we do not inject more than aggregate allows.
    const styles = doc.querySelectorAll("style[data-epub-injected-css]");
    expect(styles.length).toBeLessThanOrEqual(2);
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it("normalizes protocol-relative external links for parent open bridge", () => {
    const doc = parseHtml(`<!DOCTYPE html><html><body>
      <a href="//evil.example/out">proto</a>
    </body></html>`);
    transformChapter(doc, localResolver);
    const a = doc.querySelector("a")!;
    expect(a.getAttribute("href")).toBe("https://evil.example/out");
    expect(a.getAttribute("data-epub-external")).toBe("1");
    expect(a.getAttribute("rel")).toContain("noopener");
  });

  it("srcset reveal fails closed when materialize returns non-blob paths", async () => {
    const doc = parseHtml(`<!DOCTYPE html><html><body>
      <img src="images/a.png" srcset="images/a.png 1x, images/a@2x.png 2x" alt="a">
    </body></html>`);
    const resolver: ArchiveResolver = (raw) => {
      const base = raw.split(/\s+/)[0]!;
      if (base.startsWith("images/")) return base;
      return null;
    };
    transformChapter(doc, resolver, {
      materializeArchiveUrl: async () => "images/leaked.png",
    });
    const img = doc.querySelector("img")!;
    const button = doc.querySelector("button")!;
    button.click();
    // Let async reveal settle.
    await new Promise((r) => setTimeout(r, 20));
    expect(img.getAttribute("src")).toBeNull();
    expect(img.getAttribute("srcset")).toBeNull();
  });
});
