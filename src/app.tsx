import { useCallback, useEffect, useMemo, useState } from "preact/hooks";
import "./app.css";
import type {
  LibraryBook,
  StoredBook,
  StoredProgress,
  ValidatedImport,
} from "./domain/types";
import { BookRepository } from "./library/book-repository";
import {
  LibraryScreen,
  type BookSelection,
  type LibraryRepository,
} from "./library/library-screen";
import { isImportError } from "./library/import-errors";
import { openDatabase } from "./library/idb";
import { validateEpub } from "./library/epub-validator";
import { ReaderScreen } from "./reader/reader-screen";
import { SettingsRepository } from "./settings/settings-repository";
import {
  deleteShareInboxEntry,
  expireShareInbox,
  getShareInboxEntry,
  SHARE_INBOX_TTL_MS,
} from "./sw/share-import";

/**
 * In-memory library used when IndexedDB is unavailable or quota fails.
 * Data does not survive reload — callers must surface session-only warnings.
 */
class SessionOnlyRepository implements LibraryRepository {
  private books = new Map<string, StoredBook>();
  private progress = new Map<string, StoredProgress>();

  async listBooks(): Promise<LibraryBook[]> {
    return Array.from(this.books.values()).map((book) => {
      const entry: LibraryBook = {
        book: {
          id: book.id,
          fileName: book.fileName,
          byteLength: book.byteLength,
          title: book.title,
          savedAt: book.savedAt,
          ...(book.creator !== undefined ? { creator: book.creator } : {}),
          ...(book.lastOpenedAt !== undefined
            ? { lastOpenedAt: book.lastOpenedAt }
            : {}),
        },
      };
      const progress = this.progress.get(book.id);
      if (progress) entry.progress = progress;
      return entry;
    });
  }

  async importBook(input: ValidatedImport): Promise<StoredBook> {
    const id =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `session-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const book: StoredBook = {
      id,
      fileName: input.fileName,
      byteLength: input.epub.size,
      epub: input.epub,
      title: input.title,
      savedAt: Date.now(),
    };
    if (input.creator !== undefined) {
      book.creator = input.creator;
    }
    this.books.set(id, book);
    return book;
  }

  async deleteBook(id: string): Promise<void> {
    this.books.delete(id);
    this.progress.delete(id);
  }

  async getBook(id: string): Promise<StoredBook | undefined> {
    const book = this.books.get(id);
    if (!book) return undefined;
    book.lastOpenedAt = Date.now();
    return book;
  }

  async saveProgress(progress: StoredProgress): Promise<void> {
    this.progress.set(progress.bookId, progress);
  }
}

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
  const durableRepository = useMemo(() => new BookRepository(), []);
  const sessionRepository = useMemo(() => new SessionOnlyRepository(), []);
  const settingsRepository = useMemo(() => new SettingsRepository(), []);
  const [sessionOnly, setSessionOnly] = useState(false);
  const [sessionOnlyMessage, setSessionOnlyMessage] = useState<string | null>(
    null,
  );
  const [idbReady, setIdbReady] = useState(false);
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

  const repository: BookRepository | SessionOnlyRepository = sessionOnly
    ? sessionRepository
    : durableRepository;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Probe durable storage with a short timeout so UI is never stuck loading.
        const db = await Promise.race([
          openDatabase(),
          new Promise<never>((_, reject) => {
            setTimeout(() => reject(new Error("IndexedDB open timed out")), 2000);
          }),
        ]);
        db.close();
        // Confirm list path works on the split meta store.
        await durableRepository.listBooks();
        if (!cancelled) {
          setSessionOnly(false);
          setSessionOnlyMessage(null);
          setIdbReady(true);
        }
      } catch {
        if (!cancelled) {
          setSessionOnly(true);
          setSessionOnlyMessage(
            "無法開啟本機書庫（可能是私密模式或儲存空間不足）。目前為工作階段模式：書籍與進度不會在重新載入後保留。",
          );
          setIdbReady(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [durableRepository]);

  useEffect(() => {
    if (!idbReady || sessionOnly) {
      if (idbReady && sessionOnly) {
        setShareBootstrapping(false);
      }
      return;
    }

    let cancelled = false;

    (async () => {
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

      try {
        const entry = await getShareInboxEntry(shareId);
        if (!entry) {
          if (!cancelled) {
            setShareError("找不到分享的 EPUB，請改用「匯入 EPUB」。");
            clearShareImportQuery();
          }
          return;
        }

        if (Date.now() - entry.receivedAt > SHARE_INBOX_TTL_MS) {
          await deleteShareInboxEntry(shareId);
          if (!cancelled) {
            setShareError("分享的 EPUB 已過期，請重新分享或使用「匯入 EPUB」。");
            clearShareImportQuery();
          }
          return;
        }

        const validated = await validateEpub(entry.epub, entry.fileName);
        await durableRepository.promoteShare(shareId, validated);
        // Clear the query only after a successful promote so transient failures
        // keep a retry path via the still-staged inbox id.
        clearShareImportQuery();
        if (!cancelled) {
          setLibraryKey((key) => key + 1);
          setShareError(null);
        }
      } catch (error) {
        try {
          if (isImportError(error)) {
            await deleteShareInboxEntry(shareId);
            clearShareImportQuery();
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
  }, [idbReady, sessionOnly, durableRepository]);

  const handleOpenBook = useCallback(
    async (next: BookSelection) => {
      try {
        const book = await repository.getBook(next.book.id);
        if (book && "epub" in book && book.epub) {
          const selection: BookSelection = { book };
          if (next.progress) {
            selection.progress = next.progress;
          }
          setSelection(selection);
          return;
        }
      } catch {
        // Fall through to error path.
      }
      // Never open a reader without a real payload.
      setShareError("無法開啟此書。請重新匯入。");
    },
    [repository],
  );

  if (selection && "epub" in selection.book && selection.book.epub) {
    return (
      <ReaderScreen
        book={selection.book as StoredBook}
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
      {shareBootstrapping || !idbReady ? (
        <div class="app-shell" role="status">
          <p>{shareBootstrapping ? "正在匯入分享的 EPUB…" : "載入中…"}</p>
        </div>
      ) : (
        <LibraryScreen
          key={libraryKey}
          repository={repository}
          sessionOnly={sessionOnly}
          sessionOnlyMessage={sessionOnlyMessage}
          onOpenBook={(next) => {
            void handleOpenBook(next);
          }}
        />
      )}
    </>
  );
}
