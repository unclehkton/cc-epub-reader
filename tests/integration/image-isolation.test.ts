import { describe, expect, it } from "vitest";
import {
  type ArchiveResolver,
  transformChapter,
} from "../../src/reader/chapter-transformer";

function parseHtml(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

/**
 * Integration-style proof that chapter documents leave transform with no live
 * image network surface, and only resolver-approved archive URLs become
 * restorable after an explicit reader action.
 */
describe("image isolation (pre-serialization)", () => {
  const archiveResolver: ArchiveResolver = (rawUrl) => {
    // Mimic EPUB.js archive resolution: only relative package paths.
    const trimmed = rawUrl.trim();
    if (
      trimmed.startsWith("http:") ||
      trimmed.startsWith("https:") ||
      trimmed.startsWith("//") ||
      /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)
    ) {
      // Caller must not rely on the resolver for scheme rejection; helpers do that.
      return null;
    }
    if (trimmed.includes("..")) return null;
    if (!trimmed || trimmed.startsWith("/")) return null;
    return `blob:epub-archive/${trimmed}`;
  };

  it("emits zero live image sources for a mixed local/remote chapter before activation", () => {
    const doc = parseHtml(`<!DOCTYPE html><html><body>
      <h1>章節</h1>
      <img id="local" src="images/chapter-1.png" alt="本地圖">
      <img id="remote" src="https://tracker.example/pixel.gif" alt="遙距">
      <img id="srcset" src="images/a.png"
           srcset="images/a.png 1x, https://evil.example/b.png 2x" alt="混合">
      <picture>
        <source srcset="https://cdn.example/wide.jpg" media="(min-width: 600px)">
        <img id="pic" src="images/narrow.jpg" alt="響應式">
      </picture>
      <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20">
        <image id="svg-remote" href="https://evil.example/x.png" width="20" height="20" />
        <image id="svg-local" href="images/icon.png" width="20" height="20" />
      </svg>
    </body></html>`);

    transformChapter(doc, archiveResolver);

    const liveFetchSurface = Array.from(
      doc.querySelectorAll("img, image, source"),
    ).flatMap((el) => [
      el.getAttribute("src"),
      el.getAttribute("srcset"),
      el.getAttribute("href"),
      el.getAttribute("xlink:href"),
      el.getAttributeNS?.("http://www.w3.org/1999/xlink", "href") ?? null,
    ]);

    for (const value of liveFetchSurface) {
      expect(value).toBeNull();
    }

    // No residual remote or javascript URLs in data attributes either.
    const serialized = new XMLSerializer().serializeToString(doc);
    expect(serialized).not.toMatch(/https:\/\/tracker\.example/i);
    expect(serialized).not.toMatch(/https:\/\/evil\.example/i);
    expect(serialized).not.toMatch(/https:\/\/cdn\.example/i);
    expect(serialized).not.toMatch(/javascript:/i);

    const local = doc.getElementById("local") as HTMLImageElement;
    expect(local.getAttribute("data-epub-src")).toBe("blob:epub-archive/images/chapter-1.png");

    const remote = doc.getElementById("remote") as HTMLImageElement;
    expect(remote.getAttribute("data-epub-src")).toBeNull();

    const buttons = Array.from(doc.querySelectorAll("button")).filter(
      (b) => b.textContent?.trim() === "點擊顯示圖片",
    );
    expect(buttons.length).toBeGreaterThanOrEqual(1);
  });

  it("reveals only one validated archive URL when the gate is activated", () => {
    const doc = parseHtml(`<!DOCTYPE html><html><body>
      <img id="a" src="images/a.png" alt="A">
      <img id="b" src="images/b.png" alt="B">
      <img id="r" src="https://evil.example/r.png" alt="R">
    </body></html>`);

    const result = transformChapter(doc, archiveResolver);

    const imgA = doc.getElementById("a") as HTMLImageElement;
    const imgB = doc.getElementById("b") as HTMLImageElement;
    const imgR = doc.getElementById("r") as HTMLImageElement;

    const gates = Array.from(doc.querySelectorAll("button")).filter(
      (b) => b.textContent?.trim() === "點擊顯示圖片",
    );
    expect(gates.length).toBe(2); // only local images

    // Activate the gate associated with image A.
    let activateA: HTMLButtonElement | null = null;
    for (const g of gates) {
      if (
        g.parentElement?.contains(imgA) ||
        g.nextElementSibling === imgA ||
        g.previousElementSibling === imgA
      ) {
        activateA = g;
        break;
      }
    }
    expect(activateA).toBeTruthy();
    activateA!.click();

    expect(imgA.getAttribute("src")).toBe("blob:epub-archive/images/a.png");
    expect(imgB.getAttribute("src")).toBeNull();
    expect(imgR.getAttribute("src")).toBeNull();
    expect(imgR.getAttribute("data-epub-src")).toBeNull();

    result.dispose();
  });

  it("rejects activation payloads that are not archive-approved even if data attributes are tampered", () => {
    const doc = parseHtml(`<!DOCTYPE html><html><body>
      <img id="local" src="images/ok.png" alt="ok">
    </body></html>`);

    transformChapter(doc, archiveResolver);
    const img = doc.getElementById("local") as HTMLImageElement;
    // Hostile mutation after transform (should still not fetch remote).
    img.setAttribute("data-epub-src", "https://evil.example/pwn.png");

    const button = Array.from(doc.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "點擊顯示圖片",
    )!;
    button.click();

    const src = img.getAttribute("src");
    expect(src === null || !/^https?:/i.test(src)).toBe(true);
    expect(src).not.toBe("https://evil.example/pwn.png");
  });

  it("disposes all reveal listeners and does not leave dangling handlers", () => {
    const doc = parseHtml(`<!DOCTYPE html><html><body>
      <img src="images/one.png" alt="1">
      <img src="images/two.png" alt="2">
    </body></html>`);

    const result = transformChapter(doc, archiveResolver);
    const buttons = Array.from(doc.querySelectorAll("button")).filter(
      (b) => b.textContent?.trim() === "點擊顯示圖片",
    );
    expect(buttons.length).toBe(2);

    result.dispose();

    for (const img of Array.from(doc.querySelectorAll("img"))) {
      img.removeAttribute("src");
    }
    for (const button of buttons) {
      button.click();
    }
    for (const img of Array.from(doc.querySelectorAll("img"))) {
      expect(img.getAttribute("src")).toBeNull();
    }
  });

  it("never calls the archive resolver with rejected scheme URLs for image restore bookkeeping", () => {
    const seen: string[] = [];
    const resolver: ArchiveResolver = (raw) => {
      seen.push(raw);
      return archiveResolver(raw);
    };

    const doc = parseHtml(`<!DOCTYPE html><html><body>
      <img src="https://evil.example/x.png" alt="r">
      <img src="javascript:alert(1)" alt="j">
      <img src="//evil.example/y.png" alt="p">
      <img src="images/ok.png" alt="ok">
    </body></html>`);

    transformChapter(doc, resolver);

    expect(seen.some((u) => /^https?:/i.test(u))).toBe(false);
    expect(seen.some((u) => u.toLowerCase().startsWith("javascript:"))).toBe(false);
    expect(seen.some((u) => u.startsWith("//"))).toBe(false);
    expect(seen.some((u) => u.includes("images/ok.png"))).toBe(true);
  });
});
