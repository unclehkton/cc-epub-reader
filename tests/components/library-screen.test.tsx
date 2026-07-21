import { render, screen, waitFor, within } from "@testing-library/preact";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  LibraryBook,
  StoredBook,
  StoredProgress,
  ValidatedImport,
} from "../../src/domain/types";
import {
  LibraryScreen,
  type BookSelection,
  type LibraryRepository,
} from "../../src/library/library-screen";
import { makeEpub } from "../helpers/make-epub";

function makeStoredBook(
  overrides: Partial<StoredBook> & Pick<StoredBook, "id" | "title">,
): StoredBook {
  return {
    fileName: `${overrides.title}.epub`,
    byteLength: 128,
    epub: new Blob(["epub"], { type: "application/epub+zip" }),
    savedAt: Date.now(),
    ...overrides,
  };
}

class FakeRepository implements LibraryRepository {
  books: LibraryBook[] = [];

  async listBooks(): Promise<LibraryBook[]> {
    return this.books.map((row) => ({
      book: row.book,
      ...(row.progress ? { progress: row.progress } : {}),
    }));
  }

  async importBook(input: ValidatedImport): Promise<StoredBook> {
    const book: StoredBook = {
      id: `book-${this.books.length + 1}`,
      fileName: input.fileName,
      byteLength: input.epub.size,
      epub: input.epub,
      title: input.title,
      savedAt: Date.now(),
    };
    if (input.creator !== undefined) {
      book.creator = input.creator;
    }
    this.books = [{ book }, ...this.books];
    return book;
  }

  async deleteBook(id: string): Promise<void> {
    this.books = this.books.filter((row) => row.book.id !== id);
  }
}

function seed(
  repo: FakeRepository,
  title: string,
  creator: string | undefined,
  progress?: Partial<StoredProgress>,
): StoredBook {
  const book = makeStoredBook({
    id: `id-${title}`,
    title,
    ...(creator !== undefined ? { creator } : {}),
  });
  const row: LibraryBook = { book };
  if (progress) {
    row.progress = {
      bookId: book.id,
      approximatePercent: progress.approximatePercent ?? 0,
      updatedAt: progress.updatedAt ?? Date.now(),
      ...(progress.cfi !== undefined ? { cfi: progress.cfi } : {}),
      ...(progress.spineHref !== undefined
        ? { spineHref: progress.spineHref }
        : {}),
    };
  }
  repo.books.push(row);
  return book;
}

describe("LibraryScreen", () => {
  let repository: FakeRepository;
  let opened: BookSelection[];
  let persistMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    repository = new FakeRepository();
    opened = [];
    persistMock = vi.fn().mockResolvedValue(true);
    Object.defineProperty(navigator, "storage", {
      configurable: true,
      value: { persist: persistMock },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function renderScreen() {
    return render(
      <LibraryScreen
        repository={repository}
        onOpenBook={(selection) => {
          opened.push(selection);
        }}
      />,
    );
  }

  it("lists title, creator, glyph, and progress from the repository", async () => {
    seed(repository, "圍城", "錢鍾書", { approximatePercent: 42 });
    seed(repository, "邊城", "沈從文");

    renderScreen();

    await waitFor(() => {
      expect(screen.getByText("圍城")).toBeTruthy();
    });

    expect(screen.getByText("錢鍾書")).toBeTruthy();
    expect(screen.getByText("42%")).toBeTruthy();
    expect(screen.getByText("邊城")).toBeTruthy();
    expect(screen.getByText("沈從文")).toBeTruthy();
    expect(screen.getByText("尚未開始")).toBeTruthy();
    // First-character glyphs for each title.
    expect(screen.getByText("圍")).toBeTruthy();
    expect(screen.getByText("邊")).toBeTruthy();
  });

  it("imports through a hidden EPUB file input and shows the new book", async () => {
    const user = userEvent.setup();
    renderScreen();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "匯入 EPUB" })).toBeTruthy();
    });

    const fileInput = document.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement | null;
    expect(fileInput).toBeTruthy();
    expect(fileInput!.hidden || fileInput!.getAttribute("hidden") !== null ||
      getComputedStyle(fileInput!).display === "none" ||
      fileInput!.classList.contains("visually-hidden") ||
      fileInput!.getAttribute("aria-hidden") === "true" ||
      fileInput!.tabIndex === -1 ||
      fileInput!.style.display === "none" ||
      fileInput!.hasAttribute("hidden")).toBe(true);
    expect(fileInput!.getAttribute("accept")).toBe(
      ".epub,application/epub+zip",
    );

    const epub = await makeEpub({ title: "傾城之戀", creator: "張愛玲" });
    const file = new File([epub], "傾城之戀.epub", {
      type: "application/epub+zip",
    });

    await user.upload(fileInput!, file);

    await waitFor(() => {
      expect(screen.getByText("傾城之戀")).toBeTruthy();
    });
    expect(screen.getByText("張愛玲")).toBeTruthy();
    expect(repository.books).toHaveLength(1);
    expect(persistMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the existing list after an invalid import", async () => {
    const user = userEvent.setup();
    seed(repository, "圍城", "錢鍾書", { approximatePercent: 10 });
    renderScreen();

    await waitFor(() => {
      expect(screen.getByText("圍城")).toBeTruthy();
    });

    const fileInput = document.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    const bad = new File(["not-a-zip"], "bad.epub", {
      type: "application/epub+zip",
    });
    await user.upload(fileInput, bad);

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toMatch(/無法匯入/);
    });

    expect(screen.getByText("圍城")).toBeTruthy();
    expect(screen.getByText("錢鍾書")).toBeTruthy();
    expect(repository.books).toHaveLength(1);
    expect(persistMock).not.toHaveBeenCalled();
  });

  it("opens the selected book with its progress", async () => {
    const user = userEvent.setup();
    seed(repository, "圍城", "錢鍾書", {
      approximatePercent: 42,
      cfi: "epubcfi(/6/4)",
    });
    renderScreen();

    await waitFor(() => {
      expect(screen.getByText("圍城")).toBeTruthy();
    });

    await user.click(screen.getByRole("button", { name: "開啟 圍城" }));

    await waitFor(() => {
      expect(opened).toHaveLength(1);
    });
    expect(opened[0]!.book.title).toBe("圍城");
    expect(opened[0]!.progress?.approximatePercent).toBe(42);
    expect(opened[0]!.progress?.cfi).toBe("epubcfi(/6/4)");
  });

  it("deletes only after a dialog that names the book is confirmed", async () => {
    const user = userEvent.setup();
    seed(repository, "圍城", "錢鍾書");
    seed(repository, "邊城", "沈從文");
    renderScreen();

    await waitFor(() => {
      expect(screen.getByText("圍城")).toBeTruthy();
    });

    const overflow = screen.getByRole("button", { name: /更多.*圍城/ });
    await user.click(overflow);

    const deleteAction = screen.getByRole("menuitem", { name: "刪除" });
    await user.click(deleteAction);

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/圍城/)).toBeTruthy();
    expect(screen.getByText("邊城")).toBeTruthy();

    await user.click(within(dialog).getByRole("button", { name: "刪除" }));

    await waitFor(() => {
      expect(screen.queryByText("圍城")).toBeNull();
    });
    expect(screen.getByText("邊城")).toBeTruthy();
    expect(repository.books.map((row) => row.book.title)).toEqual(["邊城"]);
  });

  it("restores focus to the overflow button when deletion is cancelled", async () => {
    const user = userEvent.setup();
    seed(repository, "圍城", "錢鍾書");
    renderScreen();

    await waitFor(() => {
      expect(screen.getByText("圍城")).toBeTruthy();
    });

    const overflow = screen.getByRole("button", { name: /更多.*圍城/ });
    await user.click(overflow);
    await user.click(screen.getByRole("menuitem", { name: "刪除" }));

    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "取消" }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(document.activeElement).toBe(overflow);
    expect(screen.getByText("圍城")).toBeTruthy();
  });

  it("sizes import and overflow controls for 44px touch targets", async () => {
    seed(repository, "圍城", "錢鍾書");
    renderScreen();

    await waitFor(() => {
      expect(screen.getByText("圍城")).toBeTruthy();
    });

    const importButton = screen.getByRole("button", { name: "匯入 EPUB" });
    const overflow = screen.getByRole("button", { name: /更多.*圍城/ });

    for (const control of [importButton, overflow]) {
      const styles = getComputedStyle(control);
      expect(styles.minWidth).toMatch(/px$/);
      expect(styles.minHeight).toMatch(/px$/);
      expect(parseFloat(styles.minWidth)).toBeGreaterThanOrEqual(44);
      expect(parseFloat(styles.minHeight)).toBeGreaterThanOrEqual(44);
    }
  });

  it("explains storage limits without claiming a folder or guaranteed backup", async () => {
    renderScreen();

    await waitFor(() => {
      expect(screen.getByText("書籍只會儲存在此裝置")).toBeTruthy();
    });

    const notice =
      screen.getByText(/網站資料|瀏覽器|清除|解除安裝|回收/).textContent ?? "";
    expect(notice.length).toBeGreaterThan(0);
    // Must not market browser storage as a normal folder or absolute backup.
    expect(notice).not.toMatch(/保證備份|永久保存|檔案總管|資料夾中/);
    expect(notice.toLowerCase()).not.toMatch(/guaranteed backup|normal folder/);
  });
});
