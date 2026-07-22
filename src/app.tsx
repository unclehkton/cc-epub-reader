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

  /** Adopt a durable book (same id) when falling back mid-session. */
  adoptBook(book: StoredBook): void {
    this.books.set(book.id, {
      ...book,
      epub: book.epub,
    });
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

function isStorageFailure(error: unknown): boolean {
  if (error == null) return false;
  // DOMException and plain objects both appear in browsers/tests.
  const name =
    typeof error === "object" && error !== null && "name" in error
      ? String((error as { name?: unknown }).name ?? "")
      : "";
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "object" && error !== null && "message" in error
        ? String((error as { message?: unknown }).message ?? "")
        : String(error);
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? Number((error as { code?: unknown }).code)
      : undefined;
  // QuotaExceededError code is 22 in some engines; NS_ERROR_DOM_QUOTA_REACHED is 1014.
  if (code === 22 || code === 1014) return true;
  return (
    name === "QuotaExceededError" ||
    name === "InvalidStateError" ||
    name === "UnknownError" ||
    name === "TransactionInactiveError" ||
    /quota|indexeddb|idb|storage|disk|full/i.test(message)
  );
}

/**
 * Prefer durable IndexedDB; on quota/open failures switch permanently to
 * session-only storage for the rest of this page lifetime.
 */
class ResilientLibraryRepository implements LibraryRepository {
  private mode: "durable" | "session" = "durable";

  constructor(
    private readonly durable: BookRepository,
    private readonly session: SessionOnlyRepository,
    private readonly onEnterSessionOnly: (message: string) => void,
  ) {}

  get isSessionOnly(): boolean {
    return this.mode === "session";
  }

  private active(): BookRepository | SessionOnlyRepository {
    return this.mode === "session" ? this.session : this.durable;
  }

  forceSessionOnly(message: string): void {
    if (this.mode === "session") return;
    this.mode = "session";
    this.onEnterSessionOnly(message);
  }

  async listBooks(): Promise<LibraryBook[]> {
    try {
      return await this.active().listBooks();
    } catch (error) {
      if (this.mode === "durable" && isStorageFailure(error)) {
        this.forceSessionOnly(
          "本機書庫無法讀取，已改為工作階段模式：重新載入後書籍不會保留。",
        );
        return this.session.listBooks();
      }
      throw error;
    }
  }

  async importBook(input: ValidatedImport): Promise<StoredBook> {
    try {
      return await this.active().importBook(input);
    } catch (error) {
      if (this.mode === "durable" && isStorageFailure(error)) {
        this.forceSessionOnly(
          "本機儲存空間不足或無法寫入。已改為工作階段模式：此書只會保留到重新載入為止。",
        );
        return this.session.importBook(input);
      }
      throw error;
    }
  }

  async deleteBook(id: string): Promise<void> {
    return this.active().deleteBook(id);
  }

  async getBook(id: string): Promise<StoredBook | undefined> {
    // Prefer active store; if durable miss after a switch, also check session.
    const primary = await this.active().getBook(id);
    if (primary) return primary;
    if (this.mode === "session") return undefined;
    return this.session.getBook(id);
  }

  async saveProgress(progress: StoredProgress): Promise<void> {
    try {
      await this.active().saveProgress(progress);
    } catch (error) {
      if (this.mode === "durable" && isStorageFailure(error)) {
        // Copy the open book into session storage so progress still has a host.
        try {
          const book = await this.durable.getBook(progress.bookId);
          if (book) this.session.adoptBook(book);
        } catch {
          // Best-effort; progress may still be recorded without payload.
        }
        this.forceSessionOnly(
          "無法寫入閱讀進度到本機書庫，已改為工作階段模式。",
        );
        await this.session.saveProgress(progress);
        return;
      }
      throw error;
    }
  }

  /**
   * Promote a staged share into the active library. On durable quota failure,
   * fall back to session-only import so the user still gets the book.
   */
  async promoteShare(
    shareId: string,
    validated: ValidatedImport,
    options?: {
      deleteShare?: (id: string) => Promise<void>;
    },
  ): Promise<StoredBook> {
    const deleteShare = options?.deleteShare;
    if (this.mode === "session") {
      const book = await this.session.importBook(validated);
      if (deleteShare) {
        try {
          await deleteShare(shareId);
        } catch {
          // non-fatal
        }
      }
      return book;
    }

    try {
      return await this.durable.promoteShare(shareId, validated);
    } catch (error) {
      if (isStorageFailure(error)) {
        this.forceSessionOnly(
          "本機儲存空間不足。已改為工作階段模式匯入分享的 EPUB：重新載入後不會保留。",
        );
        const book = await this.session.importBook(validated);
        if (deleteShare) {
          try {
            await deleteShare(shareId);
          } catch {
            // non-fatal
          }
        }
        return book;
      }
      throw error;
    }
  }
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

  const repository = useMemo(
    () =>
      new ResilientLibraryRepository(
        durableRepository,
        sessionRepository,
        (message) => {
          setSessionOnly(true);
          setSessionOnlyMessage(message);
          setLibraryKey((k) => k + 1);
        },
      ),
    [durableRepository, sessionRepository],
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // WebKit (especially under Playwright) can open IDB slowly after reload.
      // A single short timeout previously forced session-only and made imported
      // books appear to vanish. Retry durable open before giving up.
      const OPEN_TIMEOUT_MS = 8_000;
      const MAX_ATTEMPTS = 3;
      let lastError: unknown;

      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
        if (cancelled) return;
        try {
          const db = await Promise.race([
            openDatabase(),
            new Promise<never>((_, reject) => {
              setTimeout(
                () => reject(new Error("IndexedDB open timed out")),
                OPEN_TIMEOUT_MS,
              );
            }),
          ]);
          db.close();
          // Prove list works on durable store before marking ready.
          await repository.listBooks();
          if (!cancelled) {
            setSessionOnly(repository.isSessionOnly);
            setIdbReady(true);
          }
          return;
        } catch (error) {
          lastError = error;
          // Hard private-mode / disabled IDB failures should not retry forever.
          if (isStorageFailure(error) && !/timed out/i.test(String(
            error instanceof Error ? error.message : error,
          ))) {
            break;
          }
          await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
        }
      }

      if (cancelled) return;
      // Only after retries fail: session-only (empty until re-import this tab).
      void lastError;
      repository.forceSessionOnly(
        "無法開啟本機書庫（可能是私密模式或儲存空間不足）。目前為工作階段模式：書籍與進度不會在重新載入後保留。",
      );
      setIdbReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [repository]);

  useEffect(() => {
    if (!idbReady) {
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
        // Resilient promote: durable first, session-only on quota.
        await repository.promoteShare(shareId, validated, {
          deleteShare: deleteShareInboxEntry,
        });
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
  }, [idbReady, repository]);

  const handleOpenBook = useCallback(
    async (next: BookSelection) => {
      try {
        const book = await repository.getBook(next.book.id);
        if (book && "epub" in book && book.epub) {
          const selection: BookSelection = { book };
          // Prefer a fresh listBooks progress snapshot over the click-time row
          // (Mobile Safari can open before the post-close remount finishes
          // wiring the latest CFI from IDB onto the list entry).
          let progress = next.progress;
          try {
            const rows = await repository.listBooks();
            const row = rows.find((r) => r.book.id === next.book.id);
            if (row?.progress) {
              progress = row.progress;
            }
          } catch {
            // keep click-time progress
          }
          if (progress) {
            selection.progress = progress;
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
          // Remount library so listBooks reloads progress/CFI after flush.
          setLibraryKey((k) => k + 1);
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
