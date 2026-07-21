import { useEffect, useId, useRef, useState } from "preact/hooks";
import type { LibraryBook } from "../domain/types";

export interface BookRowProps {
  entry: LibraryBook;
  onOpen: () => void;
  onRequestDelete: (overflowButton: HTMLButtonElement) => void;
}

function firstGlyph(title: string): string {
  const trimmed = title.trim();
  if (!trimmed) {
    return "書";
  }
  return [...trimmed][0] ?? "書";
}

function progressLabel(entry: LibraryBook): string {
  const percent = entry.progress?.approximatePercent;
  if (
    percent === undefined ||
    !Number.isFinite(percent) ||
    percent <= 0
  ) {
    return "尚未開始";
  }
  const rounded = Math.min(100, Math.max(0, Math.round(percent)));
  return `${rounded}%`;
}

export function BookRow({ entry, onOpen, onRequestDelete }: BookRowProps) {
  const { book } = entry;
  const menuId = useId();
  const [menuOpen, setMenuOpen] = useState(false);
  const overflowRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) {
      return;
    }

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (
        menuRef.current?.contains(target) ||
        overflowRef.current?.contains(target)
      ) {
        return;
      }
      setMenuOpen(false);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMenuOpen(false);
        overflowRef.current?.focus();
      }
    };

    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen]);

  return (
    <li class="book-row">
      <button
        type="button"
        class="book-row-main touch-target"
        style={{ minWidth: "44px", minHeight: "44px" }}
        aria-label={`開啟 ${book.title}`}
        onClick={onOpen}
      >
        <span class="book-glyph" aria-hidden="true">
          {firstGlyph(book.title)}
        </span>
        <span class="book-meta">
          <span class="book-title">{book.title}</span>
          {book.creator ? (
            <span class="book-creator">{book.creator}</span>
          ) : null}
          <span class="book-progress">{progressLabel(entry)}</span>
        </span>
      </button>

      <div class="book-row-actions">
        <button
          ref={overflowRef}
          type="button"
          class="book-overflow touch-target"
          style={{ minWidth: "44px", minHeight: "44px" }}
          aria-label={`更多：${book.title}`}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-controls={menuOpen ? menuId : undefined}
          onClick={() => {
            setMenuOpen((open) => !open);
          }}
        >
          ⋯
        </button>
        {menuOpen ? (
          <div
            ref={menuRef}
            id={menuId}
            class="book-overflow-menu"
            role="menu"
          >
            <button
              type="button"
              class="touch-target"
              style={{ minWidth: "44px", minHeight: "44px" }}
              role="menuitem"
              onClick={() => {
                setMenuOpen(false);
                if (overflowRef.current) {
                  onRequestDelete(overflowRef.current);
                }
              }}
            >
              刪除
            </button>
          </div>
        ) : null}
      </div>
    </li>
  );
}
