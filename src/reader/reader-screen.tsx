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
import { LicenseNotice } from "../ui/license-notice";
import { t } from "../ui/strings";
import { convertLabels } from "./convert-labels";
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
import { classifySwipe } from "./swipe";
import { TocDrawer, type TocEntry } from "./toc-drawer";

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
  const stageRef = useRef<HTMLDivElement>(null);
  const shellRef = useRef<HTMLElement>(null);
  const sessionRef = useRef<ReaderSession | null>(null);
  const settingsRef = useRef<StoredSettings>({ ...DEFAULT_SETTINGS });
  const resizeRafRef = useRef<number | null>(null);
  const touchStartRef = useRef<{
    x: number;
    y: number;
    time: number;
  } | null>(null);
  /** Suppress host click (chrome toggle) after a swipe page turn. */
  const suppressClickRef = useRef(false);
  const chromeGateRef = useRef({
    settingsOpen: false,
    licensesOpen: false,
    tocOpen: false,
    sidePanel: false,
  });

  const [settings, setSettings] = useState<StoredSettings>({
    ...DEFAULT_SETTINGS,
  });
  const [summary, setSummary] = useState<BookSummary | null>(null);
  const [tocEntries, setTocEntries] = useState<TocEntry[]>([]);
  const [location, setLocation] = useState<ReaderLocation | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "error">("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [conversionError, setConversionError] = useState<string | null>(null);
  const [chromeVisible, setChromeVisible] = useState(true);
  const [tocOpen, setTocOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [licensesOpen, setLicensesOpen] = useState(false);
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

  const uiLang = settings.uiLanguage ?? "zh-Hant";
  const tocSide = settings.tocSide ?? "left";
  const marginPercent = settings.horizontalMarginPercent ?? 4;

  // Keep refs in sync for event handlers that close over stale state.
  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  useEffect(() => {
    chromeGateRef.current = {
      settingsOpen,
      licensesOpen,
      tocOpen,
      sidePanel,
    };
  }, [settingsOpen, licensesOpen, tocOpen, sidePanel]);

  useEffect(() => {
    const detach = tracker.attachLifecycle(window);
    return () => {
      detach();
      tracker.flushBestEffort();
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

  // Convert TOC labels when conversion mode or summary changes.
  useEffect(() => {
    let cancelled = false;
    const source = summary?.toc ?? [];
    if (source.length === 0) {
      setTocEntries([]);
      return;
    }
    const mode = settings.conversion;
    if (mode === "original") {
      setTocEntries(source.map((e) => ({ label: e.label, href: e.href })));
      return;
    }
    void (async () => {
      const labels = await convertLabels(
        source.map((e) => e.label),
        mode,
      );
      if (cancelled) return;
      setTocEntries(
        source.map((entry, i) => ({
          href: entry.href,
          label: labels[i] ?? entry.label,
        })),
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [summary, settings.conversion]);

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

      session = createSession({
        element: host,
        flow: loadedSettings.flow,
        conversion: loadedSettings.conversion,
        appearance: {
          fontSizePercent: loadedSettings.fontSizePercent,
          fontFamily: loadedSettings.fontFamily,
          background: loadedSettings.background,
          theme: loadedSettings.theme,
          horizontalMarginPercent: loadedSettings.horizontalMarginPercent ?? 4,
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
          setConversionError(
            event.message ||
              (settingsRef.current.uiLanguage === "zh-Hans"
                ? "字体转换失败，已还原原文。"
                : "字體轉換失敗，已還原原文。"),
          );
        } else if (event.type === "content-tap") {
          // Chapter iframe taps do not bubble to the parent host.
          const gate = chromeGateRef.current;
          if (
            !gate.settingsOpen &&
            !gate.licensesOpen &&
            !(gate.tocOpen && !gate.sidePanel)
          ) {
            setChromeVisible((v) => !v);
          }
        }
      });

      try {
        // Prefer durable ArrayBuffer identity — avoids Blob→ArrayBuffer copy.
        const bookSummary = await session.open(book.epubBytes ?? book.epub, {
          cfi: progress?.cfi,
          spineHref: progress?.spineHref,
          approximatePercent: progress?.approximatePercent,
        });
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
            : settingsRef.current.uiLanguage === "zh-Hans"
              ? "无法开启此书。"
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

  // Resize / orientation: coalesce with rAF and resize the existing rendition.
  // Rebuilding via setFlow destroys the iframe and can race during window drag.
  useEffect(() => {
    const onResize = () => {
      if (resizeRafRef.current !== null) {
        return;
      }
      resizeRafRef.current = window.requestAnimationFrame(() => {
        resizeRafRef.current = null;
        const session = sessionRef.current;
        if (!session) return;
        session.resize();
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
    root.lang = settings.uiLanguage === "zh-Hans" ? "zh-Hans" : "zh-Hant";
    return () => {
      delete root.dataset.readerTheme;
      delete root.dataset.readerBg;
    };
  }, [settings.theme, settings.background, settings.uiLanguage]);

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
        horizontalMarginPercent: next.horizontalMarginPercent ?? 4,
      });

      if (next.flow !== prev.flow) {
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
    void sessionRef.current?.goPrevious().catch(() => {
      // Session already emits status; consume rejection.
    });
  }, []);

  const goNext = useCallback(() => {
    void sessionRef.current?.goNext().catch(() => {
      // Session already emits status; consume rejection.
    });
  }, []);

  const handleTocSelect = useCallback(
    (href: string) => {
      void sessionRef.current?.display(href).catch(() => {
        // status event
      });
      if (!sidePanel) {
        setTocOpen(false);
      }
    },
    [sidePanel],
  );

  const toggleChrome = useCallback(() => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    if (settingsOpen || licensesOpen || (tocOpen && !sidePanel)) {
      return;
    }
    setChromeVisible((v) => !v);
  }, [settingsOpen, licensesOpen, tocOpen, sidePanel]);

  // Swipe left/right for page turns (mobile).
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;

    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 1) {
        touchStartRef.current = null;
        return;
      }
      const touch = event.touches[0]!;
      touchStartRef.current = {
        x: touch.clientX,
        y: touch.clientY,
        time: Date.now(),
      };
    };

    const onTouchEnd = (event: TouchEvent) => {
      const start = touchStartRef.current;
      touchStartRef.current = null;
      if (!start || event.changedTouches.length === 0) return;
      // Paginated mode only — scrolled mode needs vertical free scroll.
      if (settingsRef.current.flow !== "paginated") return;
      if (settingsOpen || licensesOpen || (tocOpen && !sidePanel)) return;

      const touch = event.changedTouches[0]!;
      const direction = classifySwipe({
        startX: start.x,
        startY: start.y,
        endX: touch.clientX,
        endY: touch.clientY,
        durationMs: Date.now() - start.time,
      });
      if (!direction) return;

      suppressClickRef.current = true;
      if (direction === "left") {
        goNext();
      } else {
        goPrevious();
      }
    };

    const onTouchCancel = () => {
      touchStartRef.current = null;
    };

    stage.addEventListener("touchstart", onTouchStart, { passive: true });
    stage.addEventListener("touchend", onTouchEnd, { passive: true });
    stage.addEventListener("touchcancel", onTouchCancel, { passive: true });
    return () => {
      stage.removeEventListener("touchstart", onTouchStart);
      stage.removeEventListener("touchend", onTouchEnd);
      stage.removeEventListener("touchcancel", onTouchCancel);
    };
  }, [goNext, goPrevious, settingsOpen, licensesOpen, tocOpen, sidePanel]);

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
    // Prefer React location state (matches data-cfi shown in chrome / tests),
    // then fall back to the session's last mapped location.
    if (location) {
      tracker.onRelocated(location);
    } else {
      const loc = sessionRef.current?.getLocation();
      if (loc) {
        tracker.onRelocated(loc);
      }
    }
    void (async () => {
      try {
        await tracker.flush();
      } catch {
        // Progress may stay pending for a later lifecycle retry; never block close.
      }
      onClose();
    })();
  }, [onClose, tracker, location]);

  const percentLabel =
    location && Number.isFinite(location.approximatePercent)
      ? `${Math.round(location.approximatePercent)}%`
      : progress && Number.isFinite(progress.approximatePercent)
        ? `${Math.round(progress.approximatePercent)}%`
        : "—";

  const title = summary?.title ?? book.title;
  const chapterLabel =
    tocEntries.find(
      (entry) =>
        location?.spineHref &&
        (entry.href === location.spineHref ||
          location.spineHref.endsWith(entry.href) ||
          entry.href.endsWith(location.spineHref)),
    )?.label ??
    summary?.toc.find(
      (entry) =>
        location?.spineHref &&
        (entry.href === location.spineHref ||
          location.spineHref.endsWith(entry.href) ||
          entry.href.endsWith(location.spineHref)),
    )?.label ??
    title;

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
        tocSide === "right" ? "reader-screen--toc-right" : "",
        chromeHidden ? "reader-screen--chrome-hidden" : "",
        focusMode ? "reader-screen--focus" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      style={{
        "--reader-h-margin": `${marginPercent}%`,
      }}
      aria-label={
        uiLang === "zh-Hans" ? `阅读：${title}` : `閱讀：${title}`
      }
      data-spine-href={location?.spineHref ?? ""}
      data-cfi={location?.cfi ?? ""}
      data-progress-percent={
        location && Number.isFinite(location.approximatePercent)
          ? String(location.approximatePercent)
          : ""
      }
      data-spine-index={
        location && Number.isFinite(location.spineIndex)
          ? String(location.spineIndex)
          : ""
      }
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
          aria-label={t(uiLang, "toc")}
          aria-expanded={showToc}
          onClick={() => {
            if (sidePanel) return;
            setTocOpen((open) => !open);
          }}
        >
          {t(uiLang, "toc")}
        </button>
        <div class="reader-title-block">
          <h1 class="reader-book-title">{title}</h1>
          <p class="reader-chapter-title">{chapterLabel}</p>
        </div>
        <button
          type="button"
          class="reader-icon-btn touch-target"
          style={{ minWidth: "44px", minHeight: "44px" }}
          aria-label={t(uiLang, "readingSettings")}
          aria-expanded={settingsOpen}
          onClick={() => {
            setSettingsOpen(true);
          }}
        >
          {t(uiLang, "settings")}
        </button>
        <button
          type="button"
          class="reader-icon-btn touch-target"
          style={{ minWidth: "44px", minHeight: "44px" }}
          aria-label={
            isFullscreen || focusMode
              ? t(uiLang, "exitFullscreen")
              : t(uiLang, "fullscreen")
          }
          onClick={() => {
            void handleFullscreen();
          }}
        >
          {isFullscreen || focusMode
            ? uiLang === "zh-Hans"
              ? "结束"
              : "結束"
            : t(uiLang, "fullscreen")}
        </button>
        <button
          type="button"
          class="reader-icon-btn touch-target"
          style={{ minWidth: "44px", minHeight: "44px" }}
          aria-label={t(uiLang, "backToLibrary")}
          onClick={handleClose}
        >
          {t(uiLang, "close")}
        </button>
      </header>

      <div
        class={[
          "reader-body",
          tocSide === "right" ? "reader-body--toc-right" : "",
        ]
          .filter(Boolean)
          .join(" ")}
      >
        <TocDrawer
          open={showToc}
          entries={tocEntries}
          activeHref={location?.spineHref}
          sidePanel={sidePanel}
          side={tocSide}
          uiLanguage={uiLang}
          onSelect={handleTocSelect}
          onClose={() => {
            setTocOpen(false);
          }}
        />

        <div class="reader-stage" ref={stageRef}>
          {/* Edge hit targets remain available when chrome is hidden. */}
          <button
            type="button"
            class="reader-edge reader-edge--prev touch-target"
            style={{ minWidth: "44px", minHeight: "44px" }}
            aria-label={t(uiLang, "prevPage")}
            onClick={goPrevious}
          />
          <div
            class="reader-host"
            ref={hostRef}
            role="document"
            aria-label={uiLang === "zh-Hans" ? "正文" : "正文"}
            onClick={toggleChrome}
          />
          <button
            type="button"
            class="reader-edge reader-edge--next touch-target"
            style={{ minWidth: "44px", minHeight: "44px" }}
            aria-label={t(uiLang, "nextPage")}
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
          aria-label={t(uiLang, "prevPage")}
          onClick={goPrevious}
        >
          {t(uiLang, "prevPage")}
        </button>
        <p class="reader-progress" aria-live="polite">
          {percentLabel}
        </p>
        <button
          type="button"
          class="reader-nav-btn touch-target"
          style={{ minWidth: "44px", minHeight: "44px" }}
          aria-label={t(uiLang, "nextPage")}
          onClick={goNext}
        >
          {t(uiLang, "nextPage")}
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
          {t(uiLang, "loading")}
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
        onOpenLicenses={() => {
          setSettingsOpen(false);
          setLicensesOpen(true);
        }}
      />

      <LicenseNotice
        open={licensesOpen}
        uiLanguage={uiLang}
        onClose={() => {
          setLicensesOpen(false);
        }}
      />
    </section>
  );
}
