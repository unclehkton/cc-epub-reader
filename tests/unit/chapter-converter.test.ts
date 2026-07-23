import { afterEach, describe, expect, it, vi } from "vitest";
import { ChapterConverter } from "../../src/reader/chapter-converter";
import {
  PROFILE_OPTIONS,
  clearConverterCache,
  loadConverter,
} from "../../src/reader/opencc-profiles";
import * as profiles from "../../src/reader/opencc-profiles";

function mount(html: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = html;
  document.body.appendChild(root);
  return root;
}

function textContentOf(root: ParentNode, selector: string): string {
  const el = (root as Element).querySelector(selector);
  if (!el) {
    throw new Error(`missing ${selector}`);
  }
  return el.textContent ?? "";
}

describe("opencc-profiles", () => {
  afterEach(() => {
    clearConverterCache();
    vi.restoreAllMocks();
  });

  it("maps product modes to opencc-js 1.4.1 locale options", () => {
    expect(PROFILE_OPTIONS.traditional).toEqual({ from: "cn", to: "t" });
    expect(PROFILE_OPTIONS["hong-kong"]).toEqual({ from: "cn", to: "hk" });
    expect(PROFILE_OPTIONS.taiwan).toEqual({ from: "cn", to: "twp" });
    expect(PROFILE_OPTIONS.simplified).toEqual({ from: "t", to: "cn" });
  });

  it("lazy-loads converters that perform s2t / s2hk / s2twp / t2s", async () => {
    const traditional = await loadConverter("traditional");
    const hongKong = await loadConverter("hong-kong");
    const taiwan = await loadConverter("taiwan");
    const simplified = await loadConverter("simplified");

    expect(traditional("汉语")).toBe("漢語");
    expect(hongKong("汉语")).toBe("漢語");
    expect(taiwan("汉语")).toBe("漢語");

    // Taiwan phrase path (s2twp): 软件→軟體, 鼠标→滑鼠
    expect(taiwan("软件鼠标")).toBe("軟體滑鼠");

    // Traditional → Simplified
    expect(simplified("漢語")).toBe("汉语");
  });
});

describe("ChapterConverter", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    clearConverterCache();
    vi.restoreAllMocks();
  });

  it("converts eligible text for traditional, hong-kong, and taiwan modes", async () => {
    const root = mount(`
      <p class="body">汉语软件</p>
      <p class="phrase">软件鼠标硬盘</p>
    `);
    const converter = new ChapterConverter();
    converter.capture(root);

    await converter.apply("traditional", 1);
    expect(textContentOf(root, ".body")).toBe("漢語軟件");

    await converter.apply("hong-kong", 2);
    expect(textContentOf(root, ".body")).toBe("漢語軟件");

    await converter.apply("taiwan", 3);
    expect(textContentOf(root, ".phrase")).toBe("軟體滑鼠硬碟");

    converter.destroy();
  });

  it("leaves text unchanged in original mode", async () => {
    const root = mount(`<p class="body">汉语</p>`);
    const converter = new ChapterConverter();
    converter.capture(root);

    await converter.apply("traditional", 1);
    expect(textContentOf(root, ".body")).toBe("漢語");

    await converter.apply("original", 2);
    expect(textContentOf(root, ".body")).toBe("汉语");

    converter.destroy();
  });

  it("excludes script, style, code, pre, SVG metadata, and non-visible nodes", async () => {
    const root = mount(`
      <p class="visible">汉语</p>
      <script id="s">var 汉语 = 1;</script>
      <style id="st">/* 汉语 */</style>
      <code class="code">汉语</code>
      <pre class="pre">汉语</pre>
      <p class="hidden" hidden>汉语</p>
      <p class="display-none" style="display:none">汉语</p>
      <svg xmlns="http://www.w3.org/2000/svg">
        <title id="svg-title">汉语</title>
        <desc id="svg-desc">汉语</desc>
        <metadata id="svg-meta">汉语</metadata>
        <text class="svg-text" x="0" y="12">汉语</text>
      </svg>
    `);

    const converter = new ChapterConverter();
    converter.capture(root);
    await converter.apply("traditional", 1);

    expect(textContentOf(root, ".visible")).toBe("漢語");
    expect(root.querySelector("#s")?.textContent).toContain("汉语");
    expect(root.querySelector("#st")?.textContent).toContain("汉语");
    expect(textContentOf(root, ".code")).toBe("汉语");
    expect(textContentOf(root, ".pre")).toBe("汉语");
    expect(textContentOf(root, ".hidden")).toBe("汉语");
    expect(textContentOf(root, ".display-none")).toBe("汉语");
    expect(root.querySelector("#svg-title")?.textContent).toBe("汉语");
    expect(root.querySelector("#svg-desc")?.textContent).toBe("汉语");
    expect(root.querySelector("#svg-meta")?.textContent).toBe("汉语");
    // Visible SVG text content is eligible.
    expect(textContentOf(root, ".svg-text")).toBe("漢語");

    converter.destroy();
  });

  it("restores original strings before each conversion and never chains", async () => {
    const root = mount(`<p class="body">软件</p>`);
    const converter = new ChapterConverter();
    converter.capture(root);

    await converter.apply("taiwan", 1);
    expect(textContentOf(root, ".body")).toBe("軟體");

    // Re-applying traditional must start from 软件, not from 軟體.
    await converter.apply("traditional", 2);
    expect(textContentOf(root, ".body")).toBe("軟件");

    await converter.apply("taiwan", 3);
    expect(textContentOf(root, ".body")).toBe("軟體");

    converter.destroy();
  });

  it("rejects stale generation results after await", async () => {
    const root = mount(`<p class="body">汉语</p>`);
    const converter = new ChapterConverter();
    converter.capture(root);

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const realLoad = loadConverter;
    vi.spyOn(profiles, "loadConverter").mockImplementation(async (mode) => {
      await gate;
      return realLoad(mode);
    });

    const stale = converter.apply("traditional", 1);
    // Supersede with original before the first apply finishes loading.
    const fresh = converter.apply("original", 2);
    release();
    await Promise.all([stale, fresh]);

    expect(textContentOf(root, ".body")).toBe("汉语");

    converter.destroy();
  });

  it("restores originals when conversion throws", async () => {
    const root = mount(`<p class="body">汉语</p>`);
    const converter = new ChapterConverter();
    converter.capture(root);

    await converter.apply("traditional", 1);
    expect(textContentOf(root, ".body")).toBe("漢語");

    vi.spyOn(profiles, "loadConverter").mockRejectedValue(new Error("opencc failed"));

    await expect(converter.apply("hong-kong", 2)).rejects.toThrow("opencc failed");
    expect(textContentOf(root, ".body")).toBe("汉语");

    converter.destroy();
  });

  it("restores originals when the convert function throws mid-flight", async () => {
    const root = mount(`<p class="a">汉语</p><p class="b">软件</p>`);
    const converter = new ChapterConverter();
    converter.capture(root);

    vi.spyOn(profiles, "loadConverter").mockResolvedValue((text: string) => {
      if (text.includes("软件")) {
        throw new Error("boom");
      }
      return text.replace(/汉语/g, "漢語");
    });

    await expect(converter.apply("traditional", 1)).rejects.toThrow("boom");
    expect(textContentOf(root, ".a")).toBe("汉语");
    expect(textContentOf(root, ".b")).toBe("软件");

    converter.destroy();
  });

  it("destroy clears the map so later applies are no-ops", async () => {
    const root = mount(`<p class="body">汉语</p>`);
    const converter = new ChapterConverter();
    converter.capture(root);
    converter.destroy();

    await converter.apply("traditional", 1);
    expect(textContentOf(root, ".body")).toBe("汉语");
  });
});
