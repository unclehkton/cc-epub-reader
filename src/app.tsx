import { useMemo, useState } from "preact/hooks";
import "./app.css";
import { BookRepository } from "./library/book-repository";
import {
  LibraryScreen,
  type BookSelection,
} from "./library/library-screen";

export function App() {
  const repository = useMemo(() => new BookRepository(), []);
  // Selection is retained for the reader shell (Task 8); library remains primary UI.
  const [, setSelection] = useState<BookSelection | null>(null);

  return (
    <LibraryScreen
      repository={repository}
      onOpenBook={setSelection}
    />
  );
}
