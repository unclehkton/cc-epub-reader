import { useCallback, useMemo, useState } from "preact/hooks";
import "./app.css";
import { BookRepository } from "./library/book-repository";
import {
  LibraryScreen,
  type BookSelection,
} from "./library/library-screen";
import { ReaderScreen } from "./reader/reader-screen";
import { SettingsRepository } from "./settings/settings-repository";

export function App() {
  const repository = useMemo(() => new BookRepository(), []);
  const settingsRepository = useMemo(() => new SettingsRepository(), []);
  const [selection, setSelection] = useState<BookSelection | null>(null);

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
    <LibraryScreen
      repository={repository}
      onOpenBook={(next) => {
        void handleOpenBook(next);
      }}
    />
  );
}
