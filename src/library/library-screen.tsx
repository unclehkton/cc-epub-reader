import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import type {
  BookMeta,
  LibraryBook,
  StoredBook,
  StoredProgress,
  UiLanguage,
  ValidatedImport,
} from "../domain/types";
import {
  DEFAULT_SETTINGS,
  type SettingsRepositoryLike,
} from "../settings/settings-repository";
import { LicenseNotice } from "../ui/license-notice";
import { t } from "../ui/strings";
import { BookRow } from "./book-row";
import { DeleteDialog } from "./delete-dialog";
import { isImportError } from "./import-errors";
import { StorageNotice } from "./storage-notice";
import { validateEpub } from "./epub-validator";

export interface BookSelection {
  /** May be metadata-only from the list; App must getBook() before reading. */
  book: BookMeta | StoredBook;
  progress?: StoredProgress;
}

/** Minimal repository surface used by the reading-list UI. */
export interface LibraryRepository {
  listBooks(): Promise<LibraryBook[]>;
  importBook(input: ValidatedImport): Promise<StoredBook>;
  deleteBook(id: string): Promise<void>;
}

export interface LibraryScreenProps {
  repository: LibraryRepository;
  onOpenBook: (selection: BookSelection) => void;
  /** When true, imports stay in-session only (IndexedDB unavailable). */
  sessionOnly?: boolean;
  sessionOnlyMessage?: string | null;
  /** Optional settings repo for chrome language + license entry. */
  settingsRepository?: SettingsRepositoryLike;
}

interface PendingDelete {
  book: BookMeta;
  overflowButton: HTMLButtonElement;
}

async function requestPersistentStorage(): Promise<void> {
  try {
    const storage = navigator.storage;
    if (storage && typeof storage.persist === "function") {
      await storage.persist();
    }
  } catch {
    // Persistence is best-effort; never block import on browser policy.
  }
}

export function LibraryScreen({
  repository,
  onOpenBook,
  sessionOnly = false,
  sessionOnlyMessage = null,
  settingsRepository,
}: LibraryScreenProps) {
  const [books, setBooks] = useState<LibraryBook[]>([]);
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(
    null,
  );
  const [hasRequestedPersist, setHasRequestedPersist] = useState(false);
  const [licensesOpen, setLicensesOpen] = useState(false);
  const [uiLanguage, setUiLanguage] = useState<UiLanguage>(
    DEFAULT_SETTINGS.uiLanguage ?? "zh-Hant",
  );
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!settingsRepository) return;
    let cancelled = false;
    void settingsRepository.get().then((settings) => {
      if (!cancelled) {
        setUiLanguage(settings.uiLanguage ?? "zh-Hant");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [settingsRepository]);

  const refresh = useCallback(async () => {
    const rows = await repository.listBooks();
    setBooks(rows);
  }, [repository]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const rows = await repository.listBooks();
        if (!cancelled) {
          setBooks(rows);
        }
      } catch {
        if (!cancelled) {
          setErrorMessage("無法載入書庫。");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [repository]);

  const handleImportClick = () => {
    setErrorMessage(null);
    fileInputRef.current?.click();
  };

  const handleFileChange = async (
    event: Event,
  ): Promise<void> => {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0] ?? null;
    // Allow re-selecting the same file later.
    input.value = "";
    if (!file) {
      return;
    }

    setImporting(true);
    setErrorMessage(null);
    try {
      const validated = await validateEpub(file, file.name);
      await repository.importBook(validated);
      if (!hasRequestedPersist) {
        setHasRequestedPersist(true);
        await requestPersistentStorage();
      }
      await refresh();
    } catch (error) {
      if (isImportError(error)) {
        setErrorMessage("無法匯入此 EPUB。請選擇未加密的有效 EPUB 檔案。");
      } else {
        setErrorMessage("無法匯入此 EPUB。");
      }
    } finally {
      setImporting(false);
    }
  };

  const handleConfirmDelete = async () => {
    if (!pendingDelete) {
      return;
    }
    const { book } = pendingDelete;
    setPendingDelete(null);
    try {
      await repository.deleteBook(book.id);
      await refresh();
    } catch {
      setErrorMessage("無法刪除此書。");
    }
  };

  const handleCancelDelete = () => {
    if (!pendingDelete) {
      return;
    }
    const { overflowButton } = pendingDelete;
    setPendingDelete(null);
    queueMicrotask(() => {
      overflowButton.focus();
    });
  };

  const bookCountLabel =
    books.length === 0
      ? uiLanguage === "zh-Hans"
        ? "尚未导入书籍"
        : "尚未匯入書籍"
      : uiLanguage === "zh-Hans"
        ? `${books.length} 本书`
        : `${books.length} 本書`;

  return (
    <main class="library-screen">
      <header class="library-header">
        <h1>{t(uiLanguage, "libraryTitle")}</h1>
        <p class="library-privacy">{t(uiLanguage, "libraryPrivacy")}</p>
        <StorageNotice />
        {sessionOnly || sessionOnlyMessage ? (
          <p class="library-session-only" role="status">
            {sessionOnlyMessage ?? t(uiLanguage, "sessionOnlyDefault")}
          </p>
        ) : null}
        <p class="library-count" aria-live="polite">
          {loading ? t(uiLanguage, "loading") : bookCountLabel}
        </p>
        <button
          type="button"
          class="import-button touch-target"
          style={{ minWidth: "44px", minHeight: "44px" }}
          onClick={handleImportClick}
          disabled={importing}
        >
          {t(uiLanguage, "importEpub")}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".epub,application/epub+zip"
          hidden
          onChange={handleFileChange}
        />
      </header>

      {errorMessage ? (
        <p class="library-error" role="alert">
          {errorMessage}
        </p>
      ) : null}

      <ul class="book-list" aria-label={uiLanguage === "zh-Hans" ? "书单" : "書單"}>
        {books.map((entry) => (
          <BookRow
            key={entry.book.id}
            entry={entry}
            onOpen={() => {
              const selection: BookSelection = { book: entry.book };
              if (entry.progress) {
                selection.progress = entry.progress;
              }
              onOpenBook(selection);
            }}
            onRequestDelete={(overflowButton) => {
              setPendingDelete({ book: entry.book, overflowButton });
            }}
          />
        ))}
      </ul>

      <footer class="library-footer">
        <button
          type="button"
          class="library-licenses-link touch-target"
          style={{ minWidth: "44px", minHeight: "44px" }}
          onClick={() => {
            setLicensesOpen(true);
          }}
        >
          {t(uiLanguage, "licenses")}
        </button>
      </footer>

      {pendingDelete ? (
        <DeleteDialog
          bookTitle={pendingDelete.book.title}
          onConfirm={() => {
            void handleConfirmDelete();
          }}
          onCancel={handleCancelDelete}
        />
      ) : null}

      <LicenseNotice
        open={licensesOpen}
        uiLanguage={uiLanguage}
        onClose={() => {
          setLicensesOpen(false);
        }}
      />
    </main>
  );
}
