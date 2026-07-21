# PWA EPUB Reader Release 0.1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and release a privacy-first PWA EPUB reader with a persistent multi-book local library, per-book recovery, mobile reading controls, local OpenCC conversion, tap-to-load images, and progressive-enhancement share-target import.

**Architecture:** A small Preact library shell owns user interaction, while focused domain modules own IndexedDB, EPUB validation, chapter transformation, conversion, progress, and reader-session concurrency. EPUB.js and OpenCC load only after reading intent. A custom Vite PWA service worker precaches application assets and intercepts share-target POST bodies into a short-lived IndexedDB inbox without a network fallback.

**Tech Stack:** TypeScript 7.0.2, Vite 8.1.5, Preact 10.29.7, EPUB.js 0.3.93, opencc-js 1.4.1, vite-plugin-pwa 1.3.0, Vitest 4.1.10, Testing Library, Playwright 1.61.1, IndexedDB, Workbox, Cloudflare Pages.

## Global Constraints

- Safari/iOS 15 is the minimum compatibility target; emit `es2019` and feature-detect newer browser APIs.
- EPUB bytes, extracted text, metadata, local identifiers, settings, and reading progress never leave the device.
- Every successful import creates a distinct local entry and remains until explicit deletion, subject to browser site-data controls.
- Only one spine item and one chapter-local original-text map may be active.
- Real image sources must be removed in `book.spine.hooks.content` before EPUB.js serializes the chapter.
- Touch targets are at least 44 by 44 CSS pixels and safe-area insets are respected.
- Interface copy is Traditional Chinese (Hong Kong); do not introduce Simplified Chinese UI copy.
- Production changes follow red-green-refactor and each task ends with fresh verification and a focused commit.
- No backend, remote database, analytics, Go, or Rust is introduced.

---

## File map

```text
index.html                         Static entry point
package.json                       Exact dependencies and scripts
vite.config.ts                     Preact, PWA injectManifest, chunking, test config
playwright.config.ts               Chromium/WebKit and mobile projects
src/app.tsx                        Top-level library/reader state machine
src/app.css                        Ink & Jade / Night Library responsive design
src/domain/types.ts                Shared persisted and reader types
src/library/book-repository.ts     IndexedDB schema and atomic operations
src/library/epub-validator.ts      File envelope, ZIP/EPUB, and metadata validation
src/library/library-screen.tsx     Reading-list UI, imports, progress, deletion
src/reader/chapter-transformer.ts  Sanitizer and inert image gates
src/reader/chapter-converter.ts    Original-text map and lazy OpenCC profiles
src/reader/progress-tracker.ts     Approximate progress and debounced CFI writes
src/reader/reader-session.ts       EPUB.js lifecycle and generation ownership
src/reader/reader-screen.tsx       TOC, chrome, settings, flow, fullscreen/focus
src/sw.ts                          Precache/update lifecycle and share-target POST
src/sw/share-import.ts             Local POST validation and inbox staging
public/_headers                    Cloudflare Pages security policy
public/_redirects                  Static SPA navigation fallback
public/icons/*                     Install/share-target icons
tests/fixtures/reader-fixture.epub Repository-owned multi-chapter test EPUB
tests/unit/*                       Pure module and IndexedDB tests
tests/components/*                 Preact interaction/accessibility tests
tests/integration/*                EPUB.js hook and image-isolation tests
tests/e2e/*                        Browser, offline, rotation, and resume tests
implementation-notes.html          Decisions and fresh verification evidence
```

### Task 1: Reproducible Preact and TypeScript 7 foundation

**Files:**
- Create: `package.json`, `package-lock.json`, `index.html`, `tsconfig.json`, `vite.config.ts`, `src/main.tsx`, `src/app.tsx`, `src/test/setup.ts`, `LICENSE`
- Test: `tests/components/app-shell.test.tsx`

**Interfaces:**
- Produces: `App(): JSX.Element`; scripts `check`, `test`, `test:run`, `build`, `dev`, `preview`, and `test:e2e`.

- [ ] **Step 1: Write the failing shell test**

```tsx
import { render, screen } from "@testing-library/preact";
import { describe, expect, it } from "vitest";
import { App } from "../../src/app";

describe("App", () => {
  it("introduces the private local library", () => {
    render(<App />);
    expect(screen.getByRole("heading", { name: "你的書庫" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "匯入 EPUB" })).toBeTruthy();
    expect(screen.getByText("書籍只會儲存在此裝置")).toBeTruthy();
  });
});
```

- [ ] **Step 2: Create the exact scaffold and install it**

Use this `package.json` dependency contract, run `npm install`, and commit the generated lockfile:

```json
{
  "name": "books-pkwor-epub-reader",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20.19.0" },
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "check": "tsc -b --pretty false",
    "test": "vitest",
    "test:run": "vitest run",
    "test:e2e": "playwright test",
    "preview": "vite preview"
  },
  "dependencies": {
    "epubjs": "0.3.93",
    "jszip": "3.10.1",
    "opencc-js": "1.4.1",
    "preact": "10.29.7"
  },
  "devDependencies": {
    "@playwright/test": "1.61.1",
    "@preact/preset-vite": "2.10.6",
    "@testing-library/preact": "3.2.4",
    "@testing-library/user-event": "14.6.1",
    "fake-indexeddb": "6.2.5",
    "jsdom": "29.1.1",
    "typescript": "7.0.2",
    "vite": "8.1.5",
    "vite-plugin-pwa": "1.3.0",
    "vitest": "4.1.10",
    "workbox-core": "7.4.1",
    "workbox-precaching": "7.4.1"
  }
}
```

- [ ] **Step 3: Run the test and confirm the intended failure**

Run: `npm run test:run -- tests/components/app-shell.test.tsx`

Expected: FAIL because `src/app.tsx` does not yet export `App`.

- [ ] **Step 4: Add the minimal library shell and build configuration**

```tsx
// src/app.tsx
export function App() {
  return <main><h1>你的書庫</h1><p>書籍只會儲存在此裝置</p><button type="button">匯入 EPUB</button></main>;
}
```

Configure `jsxImportSource: "preact"`, `target: "ES2019"`, strict TypeScript, jsdom Vitest setup, and Preact's Vite preset. Add the MIT license text and an `index.html` mounting `src/main.tsx` into `#app`.

- [ ] **Step 5: Verify and commit**

Run: `npm run test:run -- tests/components/app-shell.test.tsx && npm run check && npm run build`

Expected: one passing test, no TypeScript errors, and a successful `dist/` build.

```bash
git add package.json package-lock.json index.html tsconfig.json vite.config.ts src tests/components/app-shell.test.tsx LICENSE
git commit -m "build: scaffold TypeScript 7 Preact reader"
```

### Task 2: IndexedDB multi-book repository

**Files:**
- Create: `src/domain/types.ts`, `src/library/idb.ts`, `src/library/book-repository.ts`
- Test: `tests/unit/book-repository.test.ts`

**Interfaces:**
- Produces: `BookRepository.importBook(input: ValidatedImport): Promise<StoredBook>`, `listBooks(): Promise<LibraryBook[]>`, `getBook(id: string)`, `saveProgress(progress: StoredProgress)`, `deleteBook(id: string)`, `stageShare(entry: ShareInboxEntry)`, and `promoteShare(id: string, validated: ValidatedImport)`.

- [ ] **Step 1: Define the persisted types and write failing repository tests**

```ts
export interface StoredBook { id: string; fileName: string; byteLength: number; epub: Blob; title: string; creator?: string; savedAt: number; lastOpenedAt?: number }
export interface StoredProgress { bookId: string; cfi?: string; spineHref?: string; approximatePercent: number; updatedAt: number }
export interface ShareInboxEntry { id: string; fileName: string; byteLength: number; epub: Blob; receivedAt: number }
export interface ValidatedImport { fileName: string; epub: Blob; title: string; creator?: string }
export interface LibraryBook { book: StoredBook; progress?: StoredProgress }
export type ConversionMode = "original" | "traditional" | "hong-kong" | "taiwan";
export interface StoredSettings { key: "reader"; flow: "paginated" | "scrolled"; conversion: ConversionMode; fontSizePercent: number; fontFamily: "book" | "sans" | "system"; background: "rice" | "white" | "sepia"; theme: "system" | "day" | "night" }
```

Tests must import `fake-indexeddb/auto` and prove: two imports remain distinct, ordering uses `lastOpenedAt` then `savedAt`, progress is per-book, deletion removes only the selected book and progress, and inbox promotion removes the inbox record in the same transaction.

- [ ] **Step 2: Run the focused test and confirm failure**

Run: `npm run test:run -- tests/unit/book-repository.test.ts`

Expected: FAIL because `BookRepository` is missing.

- [ ] **Step 3: Implement the schema and atomic operations**

Open `books-reader` version 1 with stores `books` (`id`), `progress` (`bookId`), `shareInbox` (`id`), and `settings` (`key`). Wrap each request and transaction completion in explicit Promises. Use `crypto.randomUUID()` with a `crypto.getRandomValues()` UUID fallback for iOS 15. Validate record shapes at every read, and never delete a different record after one record fails validation.

- [ ] **Step 4: Verify and commit**

Run: `npm run test:run -- tests/unit/book-repository.test.ts && npm run check`

Expected: all repository tests pass with no type errors.

```bash
git add src/domain src/library/idb.ts src/library/book-repository.ts tests/unit/book-repository.test.ts
git commit -m "feat: persist a local multi-book library"
```

### Task 3: EPUB envelope validation and metadata extraction

**Files:**
- Create: `src/library/epub-validator.ts`, `src/library/import-errors.ts`, `tests/helpers/make-epub.ts`
- Test: `tests/unit/epub-validator.test.ts`

**Interfaces:**
- Produces: `validateEpub(file: Blob, fileName: string): Promise<ValidatedImport>` and typed `ImportError` codes `missing-file | too-large | wrong-type | invalid-zip | missing-container | missing-package | encrypted`.

- [ ] **Step 1: Write failing validation tests**

Tests must prove `.epub` and `application/epub+zip` acceptance, ZIP magic rejection, `META-INF/container.xml` rootfile resolution, OPF title/creator extraction, encrypted-content rejection, and a configurable byte ceiling. Construct fixtures in memory with the ZIP implementation already supplied transitively by EPUB.js; do not call a network URL.

- [ ] **Step 2: Confirm failure**

Run: `npm run test:run -- tests/unit/epub-validator.test.ts`

Expected: FAIL because `validateEpub` is missing.

- [ ] **Step 3: Implement bounded local validation**

Use `MAX_EPUB_BYTES = 100 * 1024 * 1024`, `file.slice(0, 4).arrayBuffer()` for `PK\x03\x04`, then EPUB.js `Book.open(blob, "binary")` for the pinned library spike. Read `book.packaging.metadata`, reject `book.packaging.manifest` encryption unsupported by EPUB.js, always call `book.destroy()`, and return the original Blob rather than a second copy. Convert unknown exceptions to an `ImportError` without leaking file contents.

- [ ] **Step 4: Verify and commit**

Run: `npm run test:run -- tests/unit/epub-validator.test.ts && npm run check`

```bash
git add src/library/epub-validator.ts src/library/import-errors.ts tests/helpers/make-epub.ts tests/unit/epub-validator.test.ts
git commit -m "feat: validate local EPUB imports"
```

### Task 4: Reading-list library interface

**Files:**
- Create: `src/library/library-screen.tsx`, `src/library/book-row.tsx`, `src/library/delete-dialog.tsx`, `src/library/storage-notice.tsx`
- Modify: `src/app.tsx`, `src/app.css`
- Test: `tests/components/library-screen.test.tsx`

**Interfaces:**
- Consumes: `BookRepository` and `validateEpub`.
- Produces: `LibraryScreen({ repository, onOpenBook }): JSX.Element` and `BookSelection { book: StoredBook; progress?: StoredProgress }`.

- [ ] **Step 1: Write failing user-flow tests**

Use a fake repository to prove that the screen lists title/creator/progress, imports through a hidden `accept=".epub,application/epub+zip"` file input, keeps the existing list after invalid import, opens the selected book, and deletes only after a dialog naming the book is confirmed. Assert keyboard focus returns to the invoking overflow button when deletion is cancelled.

- [ ] **Step 2: Confirm failure**

Run: `npm run test:run -- tests/components/library-screen.test.tsx`

- [ ] **Step 3: Implement the approved Reading list**

Render generated first-character glyphs, title, creator, `尚未開始` or a percentage, and a 44-pixel overflow button. Sort through repository output only. Call `navigator.storage.persist()` after the first durable import where available; display a concise storage limitation without representing browser storage as a normal folder or guaranteed backup.

- [ ] **Step 4: Verify and commit**

Run: `npm run test:run -- tests/components/library-screen.test.tsx && npm run check`

```bash
git add src/app.tsx src/app.css src/library tests/components/library-screen.test.tsx
git commit -m "feat: add the local reading-list library"
```

### Task 5: Pre-serialization sanitizer and image gates

**Files:**
- Create: `src/reader/chapter-transformer.ts`, `src/reader/archive-url.ts`
- Test: `tests/unit/chapter-transformer.test.ts`, `tests/integration/image-isolation.test.ts`

**Interfaces:**
- Produces: `type ArchiveResolver = (rawUrl: string) => string | null`, `interface ChapterTransformResult { dispose(): void }`, and `transformChapter(document: Document, resolveArchiveUrl: ArchiveResolver): ChapterTransformResult`.

- [ ] **Step 1: Write hostile-document tests first**

Build documents containing `script`, `iframe`, `object`, `embed`, `form`, `base`, `meta[http-equiv=refresh]`, `srcdoc`, SVG animation/`foreignObject`, inline `on*` handlers, `javascript:` links, remote stylesheets, remote images, `img[srcset]`, `picture source`, and SVG images. Assert they are removed or inert. Assert each archive-local image becomes a button named `點擊顯示圖片`, no real source exists before activation, and activation restores only the validated archive URL.

- [ ] **Step 2: Confirm failure**

Run: `npm run test:run -- tests/unit/chapter-transformer.test.ts tests/integration/image-isolation.test.ts`

- [ ] **Step 3: Implement one security-critical transform path**

Walk the parsed `Document` before serialization. Permit only archive-local URLs returned by `ArchiveResolver`; reject `http:`, `https:`, protocol-relative, `javascript:`, and malformed values. Store sources in `data-epub-src`/`data-epub-srcset`, replace images with accessible gates, and attach reveal listeners through one disposer collection. Do not add a post-render fallback sanitizer.

- [ ] **Step 4: Verify and commit**

Run: `npm run test:run -- tests/unit/chapter-transformer.test.ts tests/integration/image-isolation.test.ts && npm run check`

```bash
git add src/reader/chapter-transformer.ts src/reader/archive-url.ts tests/unit/chapter-transformer.test.ts tests/integration/image-isolation.test.ts
git commit -m "feat: isolate EPUB content and gate images"
```

### Task 6: Chapter-local OpenCC conversion

**Files:**
- Create: `src/reader/chapter-converter.ts`, `src/reader/opencc-profiles.ts`
- Test: `tests/unit/chapter-converter.test.ts`

**Interfaces:**
- Consumes: `type ConversionMode = "original" | "traditional" | "hong-kong" | "taiwan"` from `src/domain/types.ts`.
- Produces: `ChapterConverter.capture(root: ParentNode): void`, `apply(mode: ConversionMode, generation: number): Promise<void>`, and `destroy(): void`.

- [ ] **Step 1: Write failing conversion tests**

Prove mode mapping `original`, `traditional`, `hong-kong`, and `taiwan`; exclude script/style/code/pre/SVG metadata/non-visible nodes; restore original strings before each conversion; reject stale generation results; and restore original text after a conversion exception.

- [ ] **Step 2: Confirm failure**

Run: `npm run test:run -- tests/unit/chapter-converter.test.ts`

- [ ] **Step 3: Implement lazy profile loading**

Use dynamic `import("opencc-js")`. Create converters `{ from: "cn", to: "t" }`, `{ from: "cn", to: "hk" }`, and `{ from: "cn", to: "tw" }` with the package's pinned API verified by a unit test. Store original text in a chapter-local `Map<Text,string>`. If measured conversion exceeds 200 ms, process a detached clone in generation-checked batches and commit only after the whole chapter succeeds.

- [ ] **Step 4: Verify and commit**

Run: `npm run test:run -- tests/unit/chapter-converter.test.ts && npm run check`

```bash
git add src/reader/chapter-converter.ts src/reader/opencc-profiles.ts tests/unit/chapter-converter.test.ts
git commit -m "feat: convert only the active chapter locally"
```

### Task 7: EPUB.js ReaderSession lifecycle

**Files:**
- Create: `src/reader/reader-session.ts`, `src/reader/epub-adapter.ts`
- Test: `tests/unit/reader-session.test.ts`, `tests/integration/epub-hook-order.test.ts`

**Interfaces:**
- Produces:

```ts
export interface ReaderLocation { cfi: string; spineHref: string; spineIndex: number; spineCount: number; chapterPage: number; chapterPages: number; approximatePercent: number }
export interface BookSummary { title: string; creator?: string; toc: Array<{ label: string; href: string }> }
export interface AppearanceSettings { fontSizePercent: number; fontFamily: "book" | "sans" | "system"; background: "rice" | "white" | "sepia"; theme: "system" | "day" | "night" }
export type ReaderEvent =
  | { type: "location"; location: ReaderLocation }
  | { type: "status"; status: "idle" | "loading" | "error"; message?: string }
  | { type: "conversion-error"; message: string };
export interface ReaderSession {
  open(source: Blob, resumeCfi?: string): Promise<BookSummary>;
  display(target?: string): Promise<void>;
  goPrevious(): Promise<void>;
  goNext(): Promise<void>;
  setFlow(flow: "paginated" | "scrolled"): Promise<void>;
  setConversion(mode: ConversionMode): Promise<void>;
  applyAppearance(settings: AppearanceSettings): void;
  getLocation(): ReaderLocation | null;
  getPersistence(): "durable" | "session-only";
  subscribe(listener: (event: ReaderEvent) => void): () => void;
  destroy(): void;
}
```

- [ ] **Step 1: Write failing generation and hook-order tests**

Use an adapter fake with deferred Promises. Start displays A then B, resolve A last, and assert only B emits location/status events. Prove `destroy()` invalidates pending work, removes listeners, destroys rendition/book, and revokes owned object URLs. With the fixture EPUB, register `book.spine.hooks.content`, assert image sources are inert in the serialized section, and prove `rendition.hooks.content` would occur after iframe content loading.

- [ ] **Step 2: Confirm failure**

Run: `npm run test:run -- tests/unit/reader-session.test.ts tests/integration/epub-hook-order.test.ts`

- [ ] **Step 3: Implement the pinned adapter and session**

Increment a monotonic generation for open, display, navigation, flow change, conversion, resize, and destroy. Check ownership after every await. Register `ChapterTransformer` only through `book.spine.hooks.content`. Use `allowScriptedContent: false`, one rendition, one visible spine item, and an explicit teardown before chapter replacement.

- [ ] **Step 4: Verify and commit**

Run: `npm run test:run -- tests/unit/reader-session.test.ts tests/integration/epub-hook-order.test.ts && npm run check`

```bash
git add src/reader/reader-session.ts src/reader/epub-adapter.ts tests/unit/reader-session.test.ts tests/integration/epub-hook-order.test.ts
git commit -m "feat: manage single-flight EPUB reader sessions"
```

### Task 8: Progress, reading modes, and reader controls

**Files:**
- Create: `src/reader/progress-tracker.ts`, `src/reader/reader-screen.tsx`, `src/reader/settings-sheet.tsx`, `src/reader/toc-drawer.tsx`, `src/settings/settings-repository.ts`
- Modify: `src/app.tsx`, `src/app.css`
- Test: `tests/unit/progress-tracker.test.ts`, `tests/components/reader-screen.test.tsx`

**Interfaces:**
- Consumes: `ReaderSession`, `BookRepository`, and `StoredSettings`.
- Produces: paginated/scrolled flow switching, appearance settings, TOC navigation, progress, fullscreen/focus, and close-to-library behavior.

- [ ] **Step 1: Write failing behavior tests**

Prove the spine-based approximation, 300 ms trailing persistence, immediate `pagehide`/hidden save, previous/next/TOC commands, CFI-preserving flow change, font/background/theme controls, four conversion labels, fullscreen fallback to focus mode, and error announcements. Use fake timers and a fake session; assert no reading action depends on hidden chrome.

- [ ] **Step 2: Confirm failure**

Run: `npm run test:run -- tests/unit/progress-tracker.test.ts tests/components/reader-screen.test.tsx`

- [ ] **Step 3: Implement the reader interface**

Use the Ink & Jade tokens by day and Night Library tokens at night. Keep control positions stable across themes. Use a portrait TOC drawer and persistent side panel only at `min-width: 900px`. Coalesce orientation/resize events with one `requestAnimationFrame`; capture the CFI, recreate the flow, and restore that CFI.

- [ ] **Step 4: Verify and commit**

Run: `npm run test:run -- tests/unit/progress-tracker.test.ts tests/components/reader-screen.test.tsx && npm run check`

```bash
git add src/app.tsx src/app.css src/reader src/settings tests/unit/progress-tracker.test.ts tests/components/reader-screen.test.tsx
git commit -m "feat: add reading modes appearance and recovery"
```

### Task 9: Offline PWA and local share target

**Files:**
- Create: `src/sw.ts`, `src/sw/share-import.ts`, `src/vite-env.d.ts`, `public/icons/icon-192.png`, `public/icons/icon-512.png`, `public/icons/maskable-512.png`
- Modify: `vite.config.ts`, `src/app.tsx`
- Test: `tests/unit/share-import.test.ts`, `tests/integration/service-worker-share.test.ts`

**Interfaces:**
- Produces: manifest `share_target`, `handleShareTarget(request): Promise<Response>`, app query handling for `share-import`, and deferred update notification.

- [ ] **Step 1: Write failing share-target tests**

Construct multipart POST Requests and prove: only `/share-target` POST is accepted; exactly one field `epub` is required; wrong type or a payload above 100 MiB is rejected; a valid Blob is staged; response redirects locally to `/?share-import=<id>`; `fetch()` is never called for the POST; and staged entries expire after 24 hours. Assert the manifest accepts both `application/epub+zip` and `.epub`.

- [ ] **Step 2: Confirm failure**

Run: `npm run test:run -- tests/unit/share-import.test.ts tests/integration/service-worker-share.test.ts`

- [ ] **Step 3: Implement injectManifest and share promotion**

Configure `VitePWA({ strategies: "injectManifest", srcDir: "src", filename: "sw.ts", manifest: { name: "Books", short_name: "Books", display: "standalone", start_url: "/", scope: "/", share_target: { action: "/share-target", method: "POST", enctype: "multipart/form-data", params: { files: [{ name: "epub", accept: ["application/epub+zip", ".epub"] }] } } } })`. In the service worker, call `event.respondWith(handleShareTarget(event.request))` before any runtime caching branch. Precache only `self.__WB_MANIFEST`. On app launch, validate and atomically promote the inbox Blob, then remove the query parameter with `history.replaceState`.

- [ ] **Step 4: Verify and commit**

Run: `npm run test:run -- tests/unit/share-import.test.ts tests/integration/service-worker-share.test.ts && npm run build`

Inspect `dist/manifest.webmanifest` and `dist/sw.js`; expected: the exact share target is present and no user-data URL or backend route is present.

```bash
git add src/sw.ts src/sw src/vite-env.d.ts src/app.tsx vite.config.ts public/icons tests/unit/share-import.test.ts tests/integration/service-worker-share.test.ts
git commit -m "feat: add offline PWA and local EPUB share target"
```

### Task 10: Cloudflare Pages security and deployment files

**Files:**
- Create: `public/_headers`, `public/_redirects`, `README.md`
- Test: `tests/unit/deployment-config.test.ts`

**Interfaces:**
- Produces: static Pages configuration with no Functions/Worker backend.

- [ ] **Step 1: Write a failing configuration test**

Read `_headers` and assert `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, a CSP starting at `default-src 'self'`, no analytics host, and a narrowly scoped `connect-src 'self'`. Read `_redirects` and assert `/share-target` is not redirected as a server POST handler; SPA GET navigation falls back to `/index.html 200`.

- [ ] **Step 2: Confirm failure**

Run: `npm run test:run -- tests/unit/deployment-config.test.ts`

- [ ] **Step 3: Add and prove the narrow CSP**

Start with `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`. Exercise the production preview and add `blob:` only to the exact directive required by the pinned EPUB.js iframe implementation. Document the proven exception in `implementation-notes.html`; do not add a broad wildcard.

- [ ] **Step 4: Verify and commit**

Run: `npm run test:run -- tests/unit/deployment-config.test.ts && npm run build`

```bash
git add public/_headers public/_redirects README.md tests/unit/deployment-config.test.ts implementation-notes.html
git commit -m "docs: configure secure Cloudflare Pages hosting"
```

### Task 11: Fixture EPUB and browser release gates

**Files:**
- Create: `tests/fixtures/reader-fixture.epub`, `tests/fixtures/large-chapter.epub`, `playwright.config.ts`, `tests/e2e/library.spec.ts`, `tests/e2e/reader.spec.ts`, `tests/e2e/offline.spec.ts`, `tests/e2e/privacy.spec.ts`, `tests/e2e/mobile.spec.ts`, `scripts/check-bundle.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces: reproducible Chromium/WebKit mobile checks and a 150 KiB gzip initial-shell budget check.

- [ ] **Step 1: Add failing end-to-end expectations**

The repository fixture must contain nested TOC entries, three chapters, Simplified Chinese text, one archive image, one remote image, and hostile markup. Tests import two books, reload, resume distinct CFIs, switch flows, convert to Hong Kong Traditional, reveal one local image, leave the chapter, delete one book, rotate portrait/landscape, and reload offline. Privacy tests fail on any request outside the preview origin and fail if an EPUB POST reaches the HTTP server.

- [ ] **Step 2: Run browser tests before completing integration**

Run: `npx playwright install chromium webkit` then `npm run test:e2e`.

Expected: FAIL on any remaining integration gap, recorded with Playwright traces.

- [ ] **Step 3: Close only evidenced integration gaps**

Wire `App` library/reader transitions, session errors, storage fallback consent, update notices, and focus restoration until each named browser scenario passes. Add `check:bundle` to gzip the entry JS/CSS chunks reachable from `index.html` and fail above 153600 bytes; lazy EPUB.js/OpenCC chunks are reported separately.

- [ ] **Step 4: Run the complete local release gate and commit**

Run: `npm run check && npm run test:run && npm run build && npm run check:bundle && npm run test:e2e`

Expected: all unit/component/integration tests pass, production build succeeds, initial shell is at most 150 KiB gzip, and Chromium/WebKit projects pass.

```bash
git add tests/fixtures tests/e2e playwright.config.ts scripts/check-bundle.mjs package.json package-lock.json src
git commit -m "test: cover offline mobile EPUB reading"
```

### Task 12: Fresh release evidence and handoff

**Files:**
- Modify: `implementation-notes.html`, `README.md`
- Create: `docs/release-checklist-0.1.md`

**Interfaces:**
- Produces: auditable local verification and the exact remaining GitHub/Cloudflare prerequisites.

- [ ] **Step 1: Review the complete diff**

Run: `git status --short && git diff --check && git diff --stat HEAD~11..HEAD`.

Confirm no generated browser profiles, EPUB user data, credentials, `.env` files, or unrelated paths are tracked.

- [ ] **Step 2: Run fresh verification in this step**

Run: `npm ci && npm run check && npm run test:run && npm run build && npm run check:bundle && npm run test:e2e`.

Start `npm run preview -- --host 127.0.0.1`, load it once online, block the network, reload, and resume both fixture books. Record exact test counts, chunk sizes, browser projects, date/time UTC+8, and any physical-iPhone limitation.

- [ ] **Step 3: Update durable documentation**

In `implementation-notes.html`, replace the pre-implementation verification note with actual command results, CSP rationale, storage behavior, share-target coverage, and follow-ups. In `README.md`, document local development, privacy, supported platforms, Cloudflare Pages build command `npm run build`, output directory `dist`, and custom-domain prerequisites.

- [ ] **Step 4: Commit the verified release candidate**

```bash
git add README.md implementation-notes.html docs/release-checklist-0.1.md
git commit -m "docs: record release 0.1 verification"
git status --short --branch
```

Expected: clean `main` worktree. Publishing to GitHub, Cloudflare Pages deployment, DNS attachment, and live-domain checks occur only when the required external credentials and repository destination are available.

## Self-review record

- Spec coverage: library, deletion, per-book resume, both flows, appearance, OpenCC modes, image isolation, single-chapter lifecycle, share target, offline startup, mobile layout, security headers, performance, testing, documentation, and deployment are each assigned to an explicit task.
- Deferred-work scan: no production behavior is left unspecified; device-only validation is identified as a release evidence constraint rather than represented as automated proof.
- Type consistency: persisted records, `ValidatedImport`, `BookRepository`, `ReaderSession`, `ConversionMode`, `StoredSettings`, and share-inbox names match the approved design and their consuming tasks.
