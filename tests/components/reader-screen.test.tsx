import { render, screen, waitFor, within } from "@testing-library/preact";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  StoredBook,
  StoredProgress,
  StoredSettings,
} from "../../src/domain/types";
import { ReaderScreen } from "../../src/reader/reader-screen";
import type {
  AppearanceSettings,
  BookSummary,
  ReaderEvent,
  ReaderLocation,
  ReaderSession,
  ReaderSessionOptions,
} from "../../src/reader/reader-session";
import {
  DEFAULT_SETTINGS,
  type SettingsRepositoryLike,
} from "../../src/settings/settings-repository";

function makeBook(overrides: Partial<StoredBook> = {}): StoredBook {
  return {
    id: "book-1",
    fileName: "demo.epub",
    byteLength: 64,
    epub: new Blob(["epub"], { type: "application/epub+zip" }),
    title: "測試書籍",
    creator: "作者",
    savedAt: Date.now(),
    ...overrides,
  };
}

function makeLocation(
  overrides: Partial<ReaderLocation> = {},
): ReaderLocation {
  return {
    cfi: "epubcfi(/6/4!/4/2/2)",
    spineHref: "ch1.xhtml",
    spineIndex: 0,
    spineCount: 3,
    chapterPage: 1,
    chapterPages: 2,
    approximatePercent: 16.7,
    ...overrides,
  };
}

class FakeSession implements ReaderSession {
  listeners = new Set<(event: ReaderEvent) => void>();
  location: ReaderLocation | null = null;
  destroyed = false;
  openCalls: Array<{ source: Blob; resumeCfi?: string }> = [];
  displayCalls: string[] = [];
  prevCalls = 0;
  nextCalls = 0;
  resizeCalls = 0;
  flowCalls: Array<"paginated" | "scrolled"> = [];
  conversionCalls: string[] = [];
  appearanceCalls: AppearanceSettings[] = [];
  private summary: BookSummary = {
    title: "測試書籍",
    creator: "作者",
    toc: [
      { label: "第一章", href: "ch1.xhtml" },
      { label: "第二章", href: "ch2.xhtml" },
    ],
  };

  constructor(public options: ReaderSessionOptions) {}

  subscribe(listener: (event: ReaderEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(event: ReaderEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  async open(source: Blob, resumeCfi?: string): Promise<BookSummary> {
    this.openCalls.push({ source, resumeCfi });
    this.emit({ type: "status", status: "loading" });
    this.location = makeLocation({
      cfi: resumeCfi ?? "epubcfi(/6/4!/4/2/2)",
    });
    this.emit({ type: "location", location: this.location });
    this.emit({ type: "status", status: "idle" });
    return this.summary;
  }

  async display(target?: string): Promise<void> {
    if (target) this.displayCalls.push(target);
    this.location = makeLocation({
      cfi: `epubcfi(${target ?? "start"})`,
      spineHref: target ?? "ch1.xhtml",
      approximatePercent: 50,
    });
    this.emit({ type: "location", location: this.location });
  }

  async goPrevious(): Promise<void> {
    this.prevCalls += 1;
    this.location = makeLocation({
      cfi: "epubcfi(prev)",
      approximatePercent: 10,
    });
    this.emit({ type: "location", location: this.location });
  }

  async goNext(): Promise<void> {
    this.nextCalls += 1;
    this.location = makeLocation({
      cfi: "epubcfi(next)",
      approximatePercent: 40,
    });
    this.emit({ type: "location", location: this.location });
  }

  resize(): void {
    this.resizeCalls += 1;
  }

  async setFlow(flow: "paginated" | "scrolled"): Promise<void> {
    this.flowCalls.push(flow);
    // CFI-preserving: keep current cfi
    const cfi = this.location?.cfi ?? "epubcfi(flow)";
    this.location = makeLocation({ cfi, approximatePercent: 33 });
    this.emit({ type: "location", location: this.location });
  }

  async setConversion(mode: Parameters<ReaderSession["setConversion"]>[0]): Promise<void> {
    this.conversionCalls.push(mode);
  }

  applyAppearance(settings: AppearanceSettings): void {
    this.appearanceCalls.push(settings);
  }

  getLocation(): ReaderLocation | null {
    return this.location;
  }

  getPersistence(): "durable" | "session-only" {
    return "durable";
  }

  destroy(): void {
    this.destroyed = true;
    this.listeners.clear();
  }

  /** Test helper: emit a session error. */
  fail(message: string): void {
    this.emit({ type: "status", status: "error", message });
  }
}

class FakeProgressRepo {
  saves: StoredProgress[] = [];
  async saveProgress(progress: StoredProgress): Promise<void> {
    this.saves.push(progress);
  }
}

class FakeSettingsRepo implements SettingsRepositoryLike {
  current: StoredSettings = { ...DEFAULT_SETTINGS };
  async get(): Promise<StoredSettings> {
    return { ...this.current };
  }
  async save(settings: StoredSettings): Promise<void> {
    this.current = { ...settings };
  }
}

describe("ReaderScreen", () => {
  let progressRepo: FakeProgressRepo;
  let settingsRepo: FakeSettingsRepo;
  let sessions: FakeSession[];
  let createSession: (options: ReaderSessionOptions) => ReaderSession;
  let closed: number;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    progressRepo = new FakeProgressRepo();
    settingsRepo = new FakeSettingsRepo();
    sessions = [];
    closed = 0;
    createSession = (options) => {
      const session = new FakeSession(options);
      sessions.push(session);
      return session;
    };
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete document.documentElement.dataset.readerTheme;
    delete document.documentElement.dataset.readerBg;
  });

  function renderReader(progress?: StoredProgress) {
    return render(
      <ReaderScreen
        book={makeBook()}
        progress={progress}
        repository={progressRepo}
        settingsRepository={settingsRepo}
        createSession={createSession}
        onClose={() => {
          closed += 1;
        }}
      />,
    );
  }

  it("opens the book at the saved CFI and shows previous/next/TOC controls", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderReader({
      bookId: "book-1",
      cfi: "epubcfi(resume)",
      approximatePercent: 20,
      updatedAt: Date.now(),
    });

    await waitFor(() => {
      expect(sessions.length).toBe(1);
      expect(sessions[0]!.openCalls[0]?.resumeCfi).toBe("epubcfi(resume)");
    });

    // Edge targets + bottom bar both expose prev/next (chrome-independent reading).
    expect(screen.getAllByRole("button", { name: "上一頁" }).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByRole("button", { name: "下一頁" }).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole("button", { name: "目錄" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "測試書籍" })).toBeTruthy();

    await user.click(screen.getAllByRole("button", { name: "下一頁" })[0]!);
    expect(sessions[0]!.nextCalls).toBe(1);

    await user.click(screen.getAllByRole("button", { name: "上一頁" })[0]!);
    expect(sessions[0]!.prevCalls).toBe(1);

    await user.click(screen.getByRole("button", { name: "目錄" }));
    const toc = await screen.findByRole("navigation", { name: "目錄" });
    await user.click(within(toc).getByRole("button", { name: "第二章" }));
    expect(sessions[0]!.displayCalls).toContain("ch2.xhtml");
  });

  it("switches flow while preserving the current CFI", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderReader();

    await waitFor(() => {
      expect(sessions[0]?.location?.cfi).toBeTruthy();
    });
    const cfiBefore = sessions[0]!.location!.cfi;

    await user.click(screen.getByRole("button", { name: "閱讀設定" }));
    await user.click(screen.getByRole("radio", { name: "捲動" }));

    await waitFor(() => {
      expect(sessions[0]!.flowCalls).toContain("scrolled");
    });
    expect(sessions[0]!.location?.cfi).toBe(cfiBefore);
    expect(settingsRepo.current.flow).toBe("scrolled");
  });

  it("resizes the active rendition in place without rebuilding its flow", async () => {
    renderReader();
    await waitFor(() => expect(sessions.length).toBe(1));

    window.dispatchEvent(new Event("resize"));
    await vi.advanceTimersByTimeAsync(20);

    expect(sessions[0]!.resizeCalls).toBe(1);
    expect(sessions[0]!.flowCalls).toHaveLength(0);
  });

  it("exposes the four conversion labels and applies conversion mode", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderReader();

    await waitFor(() => expect(sessions.length).toBe(1));

    await user.click(screen.getByRole("button", { name: "閱讀設定" }));

    expect(screen.getByRole("radio", { name: "原文" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "一般繁體" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "香港繁體" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "台灣繁體" })).toBeTruthy();

    await user.click(screen.getByRole("radio", { name: "香港繁體" }));
    await waitFor(() => {
      expect(sessions[0]!.conversionCalls).toContain("hong-kong");
    });
    expect(settingsRepo.current.conversion).toBe("hong-kong");
  });

  it("applies font size, background, and theme from the settings sheet", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderReader();
    await waitFor(() => expect(sessions.length).toBe(1));

    await user.click(screen.getByRole("button", { name: "閱讀設定" }));
    await user.click(screen.getByRole("button", { name: "放大文字" }));
    await user.click(screen.getByRole("radio", { name: "復古" }));
    await user.click(screen.getByRole("radio", { name: "夜間" }));

    await waitFor(() => {
      const calls = sessions[0]!.appearanceCalls;
      const last = calls[calls.length - 1];
      expect(last?.fontSizePercent).toBe(110);
      expect(last?.background).toBe("sepia");
      expect(last?.theme).toBe("night");
    });
  });

  it("falls back to focus mode when Fullscreen API is unavailable", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    // Ensure requestFullscreen is missing on the element prototype path.
    const original = HTMLElement.prototype.requestFullscreen;
    // @ts-expect-error override for test
    HTMLElement.prototype.requestFullscreen = undefined;

    try {
      renderReader();
      await waitFor(() => expect(sessions.length).toBe(1));

      await user.click(screen.getByRole("button", { name: "全螢幕" }));

      await waitFor(() => {
        const shell = document.querySelector(".reader-screen");
        expect(shell?.classList.contains("reader-screen--focus")).toBe(true);
      });
      expect(screen.getByRole("button", { name: "結束全螢幕" })).toBeTruthy();
    } finally {
      HTMLElement.prototype.requestFullscreen = original;
    }
  });

  it("announces session errors through an assertive live region", async () => {
    renderReader();
    await waitFor(() => expect(sessions.length).toBe(1));

    sessions[0]!.fail("章節載入失敗");

    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toContain("章節載入失敗");
      expect(screen.getByRole("alert").textContent).toContain("章節載入失敗");
    });
  });

  it("keeps previous/next usable when chrome is hidden", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderReader();
    await waitFor(() => expect(sessions.length).toBe(1));

    // Toggle chrome off by clicking the reading surface.
    await user.click(screen.getByRole("document", { name: "正文" }));

    const shell = document.querySelector(".reader-screen");
    expect(shell?.classList.contains("reader-screen--chrome-hidden")).toBe(
      true,
    );

    // Edge targets remain available — reading actions do not depend on chrome.
    const nextEdges = screen.getAllByRole("button", { name: "下一頁" });
    expect(nextEdges.length).toBeGreaterThanOrEqual(1);
    await user.click(nextEdges[0]!);
    expect(sessions[0]!.nextCalls).toBe(1);

    const prevEdges = screen.getAllByRole("button", { name: "上一頁" });
    await user.click(prevEdges[0]!);
    expect(sessions[0]!.prevCalls).toBe(1);
  });

  it("returns to the library when closed", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderReader();
    await waitFor(() => expect(sessions.length).toBe(1));

    await user.click(screen.getByRole("button", { name: "返回書庫" }));
    await waitFor(() => {
      expect(closed).toBe(1);
    });
  });

  it("debounces progress persistence at 300 ms", async () => {
    renderReader();
    await waitFor(() => expect(sessions.length).toBe(1));

    // Drain the open-time relocation debounce completely.
    await vi.advanceTimersByTimeAsync(500);
    await Promise.resolve();
    const afterOpen = progressRepo.saves.length;
    expect(afterOpen).toBeGreaterThanOrEqual(1);

    sessions[0]!.emit({
      type: "location",
      location: makeLocation({ cfi: "epubcfi(move)", approximatePercent: 44 }),
    });

    // Mid-window: still waiting for the trailing 300 ms debounce.
    await vi.advanceTimersByTimeAsync(200);
    expect(
      progressRepo.saves.some((s) => s.cfi === "epubcfi(move)"),
    ).toBe(false);

    await vi.advanceTimersByTimeAsync(150);
    await Promise.resolve();
    const lastSave = progressRepo.saves[progressRepo.saves.length - 1];
    expect(lastSave?.cfi).toBe("epubcfi(move)");
    expect(lastSave?.approximatePercent).toBe(44);
  });
});
