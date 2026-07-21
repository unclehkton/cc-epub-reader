import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import type {
  StoredBook,
  StoredProgress,
  StoredSettings,
} from "../domain/types";
import {
  DEFAULT_SETTINGS,
  type SettingsRepositoryLike,
} from "../settings/settings-repository";
import { createProgressTracker } from "./progress-tracker";
import {
  createReaderSession,
  type BookSummary,
  type ReaderEvent,
  type ReaderLocation,
  type ReaderSession,
  type ReaderSessionOptions,
} from "./reader-session";
import { SettingsSheet } from "./settings-sheet";
import { TocDrawer } from "./toc-drawer";

const SIDE_PANEL_MIN_WIDTH = 900;

export interface ReaderProgressRepository {
  saveProgress(progress: StoredProgress): Promise<void>;
}

export interface ReaderScreenProps {
  book: StoredBook;
  progress?: StoredProgress;
  repository: ReaderProgressRepository;
  settingsRepository: SettingsRepositoryLike;
  onClose: () => void;
  /** Test seam: inject a fake ReaderSession factory. */
  createSession?: (options: ReaderSessionOptions) => ReaderSession;
  /** Test seam: override matchMedia side-panel query. */
  sidePanelQuery?: string;
}

function resolveTheme(
  theme: StoredSettings["theme"],
): "day" | "night" {
  if (theme === "day") return "day";
  if (theme === "night") return "night";
  if (typeof window !== "undefined" && window.matchMedia) {
    try {
      if (window.matchMedia("(prefers-color-scheme: dark)").matches) {
        return "night";
      }
    } catch {
      // ignore
    }
  }
  return "day";
}

function supportsFullscreen(element: HTMLElement): boolean {
  return typeof element.requestFullscreen === "function";
}

export function ReaderScreen({
  book,
  progress,
  repository,
  settingsRepository,
  onClose,
  createSession = createReaderSession,
  sidePanelQuery = `(min-width: ${SIDE_PANEL_MIN_WIDTH}px)`,
}: ReaderScreenProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const shellRef = useRef<HTMLElement>(null);
  const sessionRef = useRef<ReaderSession | null>(null);
  const settingsRef = useRef<StoredSettings>({ ...DEFAULT_SETTINGS });
  const resizeRafRef = useRef<number | null>(null);
  const flowRef = useRef<StoredSettings["flow"]>("paginated");

  const [settings, setSettings] = useState<StoredSettings>({
    ...DEFAULT_SETTINGS,
  });
  const [summary, setSummary] = useState<BookSummary | null>(null);
  const [location, setLocation] = useState<ReaderLocation | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "error">("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [conversionError, setConversionError] = useState<string | null>(null);
  const [chromeVisible, setChromeVisible] = useState(true);
  const [tocOpen, setTocOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [focusMode, setFocusMode] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [sidePanel, setSidePanel] = useState(false);

  const tracker = useMemo(
    () =>
      createProgressTracker({
        bookId: book.id,
        save: (p) => repository.saveProgress(p),
      }),
    [book.id, repository],
  );

  // Keep refs in sync for event handlers that close over stale state.
  useEffect(() => {
    settingsRef.current = settings;
    flowRef.current = settings.flow;
  }, [settings]);

  useEffect(() => {
    const detach = tracker.attachLifecycle(window);
    return () => {
      detach();
      void tracker.flush();
      tracker.destroy();
    };
  }, [tracker]);

  // Side-panel media query.
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) {
      return;
    }
    const mql = window.matchMedia(sidePanelQuery);
    const update = () => {
      setSidePanel(mql.matches);
      if (mql.matches) {
        setTocOpen(true);
      }
    };
    update();
    if (typeof mql.addEventListener === "function") {
      mql.addEventListener("change", update);
      return () => {
        mql.removeEventListener("change", update);
      };
    }
    // Safari < 14
    mql.addListener(update);
    return () => {
      mql.removeListener(update);
    };
  }, [sidePanelQuery]);

  // Fullscreen change tracking.
  useEffect(() => {
    const onFs = () => {
      const active = Boolean(document.fullscreenElement);
      setIsFullscreen(active);
      if (!active) {
        // Leaving browser fullscreen does not exit focus mode automatically.
      }
    };
    document.addEventListener("fullscreenchange", onFs);
    return () => {
      document.removeEventListener("fullscreenchange", onFs);
    };
  }, []);

  // Open session once the host element mounts.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return;
    }

    let cancelled = false;
    let session: ReaderSession | null = null;
    let unsubscribe: (() => void) | null = null;

    (async () => {
      let loadedSettings = { ...DEFAULT_SETTINGS };
      try {
        loadedSettings = await settingsRepository.get();
      } catch {
        loadedSettings = { ...DEFAULT_SETTINGS };
      }
      if (cancelled) return;

      setSettings(loadedSettings);
      settingsRef.current = loadedSettings;
      flowRef.current = loadedSettings.flow;

      session = createSession({
        element: host,
        flow: loadedSettings.flow,
        conversion: loadedSettings.conversion,
        appearance: {
          fontSizePercent: loadedSettings.fontSizePercent,
          fontFamily: loadedSettings.fontFamily,
          background: loadedSettings.background,
          theme: loadedSettings.theme,
        },
        persistence: "durable",
      });
      sessionRef.current = session;

      unsubscribe = session.subscribe((event: ReaderEvent) => {
        if (event.type === "location") {
          setLocation(event.location);
          tracker.onRelocated(event.location);
        } else if (event.type === "status") {
          setStatus(event.status);
          if (event.status === "error" && event.message) {
            setErrorMessage(event.message);
          } else if (event.status === "idle") {
            setErrorMessage(null);
          }
        } else if (event.type === "conversion-error") {
          setConversionError(event.message || "字體轉換失敗，已還原原文。");
        }
      });

      try {
        const bookSummary = await session.open(book.epub, progress?.cfi);
        if (cancelled) return;
        setSummary(bookSummary);
        setStatus("idle");
        const loc = session.getLocation();
        if (loc) {
          setLocation(loc);
          tracker.onRelocated(loc);
        }
      } catch (error) {
        if (cancelled) return;
        const message =
          error instanceof Error && error.message
            ? error.message
            : "無法開啟此書。";
        setStatus("error");
        setErrorMessage(message);
      }
    })();

    return () => {
      cancelled = true;
      unsubscribe?.();
      session?.destroy();
      if (sessionRef.current === session) {
        sessionRef.current = null;
      }
    };
    // Intentionally open once per book id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [book.id]);

  // Resize / orientation: coalesce with rAF; capture CFI, reflow, restore.
  useEffect(() => {
    const onResize = () => {
      if (resizeRafRef.current !== null) {
        return;
      }
      resizeRafRef.current = window.requestAnimationFrame(() => {
        resizeRafRef.current = null;
        const session = sessionRef.current;
        if (!session) return;
        const flow = flowRef.current;
        void session.setFlow(flow).catch(() => {
          // Non-destructive: keep last CFI; surface via session events.
        });
      });
    };

    window.addEventListener("resize", onResize);
    window.addEventListener("orientationchange", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("orientationchange", onResize);
      if (resizeRafRef.current !== null) {
        window.cancelAnimationFrame(resizeRafRef.current);
        resizeRafRef.current = null;
      }
    };
  }, []);

  // Theme class on document for shell chrome.
  useEffect(() => {
    const resolved = resolveTheme(settings.theme);
    const root = document.documentElement;
    root.dataset.readerTheme = resolved;
    root.dataset.readerBg = settings.background;
    return () => {
      delete root.dataset.readerTheme;
      delete root.dataset.readerBg;
    };
  }, [settings.theme, settings.background]);

  const persistSettings = useCallback(
    async (next: StoredSettings) => {
      setSettings(next);
      settingsRef.current = next;
      try {
        await settingsRepository.save(next);
      } catch {
        // Settings persistence is best-effort for the active session.
      }
    },
    [settingsRepository],
  );

  const handleSettingsChange = useCallback(
    async (next: StoredSettings) => {
      const prev = settingsRef.current;
      await persistSettings(next);

      const session = sessionRef.current;
      if (!session) return;

      session.applyAppearance({
        fontSizePercent: next.fontSizePercent,
        fontFamily: next.fontFamily,
        background: next.background,
        theme: next.theme,
      });

      if (next.flow !== prev.flow) {
        flowRef.current = next.flow;
        try {
          await session.setFlow(next.flow);
        } catch {
          // Session emits error status.
        }
      }

      if (next.conversion !== prev.conversion) {
        setConversionError(null);
        try {
          await session.setConversion(next.conversion);
        } catch {
          // conversion-error event handles messaging.
        }
      }
    },
    [persistSettings],
  );

  const goPrevious = useCallback(() => {
    void sessionRef.current?.goPrevious();
  }, []);

  const goNext = useCallback(() => {
    void sessionRef.current?.goNext();
  }, []);

  const handleTocSelect = useCallback((href: string) => {
    void sessionRef.current?.display(href);
    if (!sidePanel) {
      setTocOpen(false);
    }
  }, [sidePanel]);

  const toggleChrome = useCallback(() => {
    if (settingsOpen || (tocOpen && !sidePanel)) {
      return;
    }
    setChromeVisible((v) => !v);
  }, [settingsOpen, tocOpen, sidePanel]);

  const handleFullscreen = useCallback(async () => {
    const shell = shellRef.current;
    if (!shell) return;

    if (isFullscreen && document.fullscreenElement) {
      try {
        await document.exitFullscreen();
      } catch {
        // ignore
      }
      setIsFullscreen(false);
      setFocusMode(false);
      setChromeVisible(true);
      return;
    }

    if (focusMode) {
      setFocusMode(false);
      setChromeVisible(true);
      return;
    }

    if (supportsFullscreen(shell)) {
      try {
        await shell.requestFullscreen();
        setIsFullscreen(true);
        setFocusMode(false);
        setChromeVisible(false);
        return;
      } catch {
        // Fall through to focus mode.
      }
    }

    // iPhone Safari / unsupported Fullscreen API → distraction-free focus mode.
    setFocusMode(true);
    setChromeVisible(false);
  }, [focusMode, isFullscreen]);

  const handleClose = useCallback(() => {
    void tracker.flush().finally(() => {
      onClose();
    });
  }, [onClose, tracker]);

  const percentLabel =
    location && Number.isFinite(location.approximatePercent)
      ? `${Math.round(location.approximatePercent)}%`
      : progress && Number.isFinite(progress.approximatePercent)
        ? `${Math.round(progress.approximatePercent)}%`
        : "—";

  const title = summary?.title ?? book.title;
  const chapterLabel =
    summary?.toc.find(
      (entry) =>
        location?.spineHref &&
        (entry.href === location.spineHref ||
          location.spineHref.endsWith(entry.href) ||
          entry.href.endsWith(location.spineHref)),
    )?.label ?? title;

  const chromeHidden = focusMode || !chromeVisible;
  const showToc = sidePanel || tocOpen;

  const resolvedTheme = resolveTheme(settings.theme);

  return (
    <section
      ref={shellRef}
      class={[
        "reader-screen",
        `reader-screen--${resolvedTheme}`,
        `reader-screen--bg-${settings.background}`,
        sidePanel ? "reader-screen--side-toc" : "",
        chromeHidden ? "reader-screen--chrome-hidden" : "",
        focusMode ? "reader-screen--focus" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      aria-label={`閱讀：${title}`}
    >
      <header
        class={[
          "reader-topbar",
          chromeHidden ? "reader-chrome--hidden" : "",
        ]
          .filter(Boolean)
          .join(" ")}
      >
        <button
          type="button"
          class="reader-icon-btn touch-target"
          style={{ minWidth: "44px", minHeight: "44px" }}
          aria-label="目錄"
          aria-expanded={showToc}
          onClick={() => {
            if (sidePanel) return;
            setTocOpen((open) => !open);
          }}
        >
          目錄
        </button>
        <div class="reader-title-block">
          <h1 class="reader-book-title">{title}</h1>
          <p class="reader-chapter-title">{chapterLabel}</p>
        </div>
        <button
          type="button"
          class="reader-icon-btn touch-target"
          style={{ minWidth: "44px", minHeight: "44px" }}
          aria-label="閱讀設定"
          aria-expanded={settingsOpen}
          onClick={() => {
            setSettingsOpen(true);
          }}
        >
          設定
        </button>
        <button
          type="button"
          class="reader-icon-btn touch-target"
          style={{ minWidth: "44px", minHeight: "44px" }}
          aria-label={
            isFullscreen || focusMode ? "結束全螢幕" : "全螢幕"
          }
          onClick={() => {
            void handleFullscreen();
          }}
        >
          {isFullscreen || focusMode ? "結束" : "全螢幕"}
        </button>
        <button
          type="button"
          class="reader-icon-btn touch-target"
          style={{ minWidth: "44px", minHeight: "44px" }}
          aria-label="返回書庫"
          onClick={handleClose}
        >
          關閉
        </button>
      </header>

      <div class="reader-body">
        <TocDrawer
          open={showToc}
          entries={summary?.toc ?? []}
          activeHref={location?.spineHref}
          sidePanel={sidePanel}
          onSelect={handleTocSelect}
          onClose={() => {
            setTocOpen(false);
          }}
        />

        <div class="reader-stage">
          {/* Edge hit targets remain available when chrome is hidden. */}
          <button
            type="button"
            class="reader-edge reader-edge--prev touch-target"
            style={{ minWidth: "44px", minHeight: "44px" }}
            aria-label="上一頁"
            onClick={goPrevious}
          />
          <div
            class="reader-host"
            ref={hostRef}
            role="document"
            aria-label="正文"
            onClick={toggleChrome}
          />
          <button
            type="button"
            class="reader-edge reader-edge--next touch-target"
            style={{ minWidth: "44px", minHeight: "44px" }}
            aria-label="下一頁"
            onClick={goNext}
          />
        </div>
      </div>

      <footer
        class={[
          "reader-bottombar",
          chromeHidden ? "reader-chrome--hidden" : "",
        ]
          .filter(Boolean)
          .join(" ")}
      >
        <button
          type="button"
          class="reader-nav-btn touch-target"
          style={{ minWidth: "44px", minHeight: "44px" }}
          aria-label="上一頁"
          onClick={goPrevious}
        >
          上一頁
        </button>
        <p class="reader-progress" aria-live="polite">
          {percentLabel}
        </p>
        <button
          type="button"
          class="reader-nav-btn touch-target"
          style={{ minWidth: "44px", minHeight: "44px" }}
          aria-label="下一頁"
          onClick={goNext}
        >
          下一頁
        </button>
      </footer>

      {/* Live region for errors — always present for SR. */}
      <div class="reader-live" aria-live="assertive" role="status">
        {errorMessage ? errorMessage : ""}
        {conversionError && !errorMessage ? conversionError : ""}
      </div>

      {errorMessage ? (
        <p class="reader-error-banner" role="alert">
          {errorMessage}
        </p>
      ) : null}

      {status === "loading" ? (
        <p class="reader-loading" aria-live="polite">
          載入中…
        </p>
      ) : null}

      <SettingsSheet
        open={settingsOpen}
        settings={settings}
        conversionError={conversionError}
        onChange={(next) => {
          void handleSettingsChange(next);
        }}
        onClose={() => {
          setSettingsOpen(false);
        }}
      />
    </section>
  );
}
