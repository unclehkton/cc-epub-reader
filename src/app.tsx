import { useCallback, useEffect, useMemo, useState } from "preact/hooks";
import "./app.css";
import { BookRepository } from "./library/book-repository";
import {
  LibraryScreen,
  type BookSelection,
} from "./library/library-screen";
import { isImportError } from "./library/import-errors";
import { validateEpub } from "./library/epub-validator";
import { ReaderScreen } from "./reader/reader-screen";
import { SettingsRepository } from "./settings/settings-repository";
import {
  deleteShareInboxEntry,
  expireShareInbox,
  getShareInboxEntry,
  SHARE_INBOX_TTL_MS,
} from "./sw/share-import";

function clearShareImportQuery(): void {
  if (typeof window === "undefined") {
    return;
  }
  const url = new URL(window.location.href);
  if (!url.searchParams.has("share-import")) {
    return;
  }
  url.searchParams.delete("share-import");
  const next = `${url.pathname}${url.search}${url.hash}`;
  window.history.replaceState(window.history.state, "", next);
}

/**
 * Register the generated service worker and surface a deferred update notice.
 * Activation is user-driven so an active reader session is not reloaded mid-book.
 */
function useDeferredServiceWorkerUpdate(): {
  needRefresh: boolean;
  applyUpdate: () => void;
} {
  const [needRefresh, setNeedRefresh] = useState(false);
  const [waitingWorker, setWaitingWorker] = useState<ServiceWorker | null>(
    null,
  );

  useEffect(() => {
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) {
      return;
    }

    let cancelled = false;
    let registration: ServiceWorkerRegistration | undefined;

    const onUpdateFound = () => {
      const installing = registration?.installing;
      if (!installing) {
        return;
      }
      installing.addEventListener("statechange", () => {
        if (
          installing.state === "installed" &&
          navigator.serviceWorker.controller &&
          !cancelled
        ) {
          setWaitingWorker(registration?.waiting ?? installing);
          setNeedRefresh(true);
        }
      });
    };

    void navigator.serviceWorker
      .register("/sw.js")
      .then((reg) => {
        if (cancelled) {
          return;
        }
        registration = reg;
        if (reg.waiting && navigator.serviceWorker.controller) {
          setWaitingWorker(reg.waiting);
          setNeedRefresh(true);
        }
        reg.addEventListener("updatefound", onUpdateFound);
      })
      .catch(() => {
        // Registration is progressive enhancement; ignore failures in tests/dev.
      });

    return () => {
      cancelled = true;
      registration?.removeEventListener("updatefound", onUpdateFound);
    };
  }, []);

  const applyUpdate = useCallback(() => {
    if (waitingWorker) {
      waitingWorker.postMessage({ type: "SKIP_WAITING" });
    }
    setNeedRefresh(false);
    if (typeof window !== "undefined") {
      window.location.reload();
    }
  }, [waitingWorker]);

  return { needRefresh, applyUpdate };
}

export function App() {
  const repository = useMemo(() => new BookRepository(), []);
  const settingsRepository = useMemo(() => new SettingsRepository(), []);
  const [selection, setSelection] = useState<BookSelection | null>(null);
  const [libraryKey, setLibraryKey] = useState(0);
  const [shareBootstrapping, setShareBootstrapping] = useState(() => {
    if (typeof window === "undefined") {
      return false;
    }
    return new URLSearchParams(window.location.search).has("share-import");
  });
  const [shareError, setShareError] = useState<string | null>(null);
  const { needRefresh, applyUpdate } = useDeferredServiceWorkerUpdate();

  useEffect(() => {
    let cancelled = false;

    (async () => {
      // Housekeeping for abandoned share-target inbox rows.
      try {
        await expireShareInbox();
      } catch {
        // Non-fatal.
      }

      if (typeof window === "undefined") {
        return;
      }

      const params = new URLSearchParams(window.location.search);
      const shareId = params.get("share-import");
      if (!shareId) {
        if (!cancelled) {
          setShareBootstrapping(false);
        }
        return;
      }

      // Drop the query immediately so reload/back does not re-import.
      clearShareImportQuery();

      try {
        const entry = await getShareInboxEntry(shareId);
        if (!entry) {
          if (!cancelled) {
            setShareError("找不到分享的 EPUB，請改用「匯入 EPUB」。");
          }
          return;
        }

        if (Date.now() - entry.receivedAt > SHARE_INBOX_TTL_MS) {
          await deleteShareInboxEntry(shareId);
          if (!cancelled) {
            setShareError("分享的 EPUB 已過期，請重新分享或使用「匯入 EPUB」。");
          }
          return;
        }

        const validated = await validateEpub(entry.epub, entry.fileName);
        await repository.promoteShare(shareId, validated);
        if (!cancelled) {
          setLibraryKey((key) => key + 1);
          setShareError(null);
        }
      } catch (error) {
        try {
          if (isImportError(error)) {
            await deleteShareInboxEntry(shareId);
          }
        } catch {
          // ignore cleanup failure
        }
        if (!cancelled) {
          setShareError(
            isImportError(error)
              ? "無法匯入分享的 EPUB。請選擇未加密的有效 EPUB 檔案。"
              : "無法匯入分享的 EPUB。",
          );
        }
      } finally {
        if (!cancelled) {
          setShareBootstrapping(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [repository]);

  const handleOpenBook = useCallback(
    async (next: BookSelection) => {
      try {
        const book = await repository.getBook(next.book.id);
        if (book) {
          const selection: BookSelection = { book };
          if (next.progress) {
            selection.progress = next.progress;
          }
          setSelection(selection);
          return;
        }
      } catch {
        // Fall back to the list selection if the refresh fails.
      }
      setSelection(next);
    },
    [repository],
  );

  if (selection) {
    return (
      <ReaderScreen
        book={selection.book}
        progress={selection.progress}
        repository={repository}
        settingsRepository={settingsRepository}
        onClose={() => {
          setSelection(null);
        }}
      />
    );
  }

  return (
    <>
      {needRefresh ? (
        <div class="sw-update-notice" role="status">
          <p>有新版本可用</p>
          <button
            type="button"
            class="sw-update-notice__action touch-target"
            onClick={applyUpdate}
          >
            重新載入
          </button>
        </div>
      ) : null}
      {shareError ? (
        <div class="share-import-error" role="alert">
          {shareError}
        </div>
      ) : null}
      {shareBootstrapping ? (
        <div class="app-shell" role="status">
          <p>正在匯入分享的 EPUB…</p>
        </div>
      ) : (
        <LibraryScreen
          key={libraryKey}
          repository={repository}
          onOpenBook={(next) => {
            void handleOpenBook(next);
          }}
        />
      )}
    </>
  );
}
