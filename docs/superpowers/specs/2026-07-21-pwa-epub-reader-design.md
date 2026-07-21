# PWA EPUB Reader Release 0.1 Design

**Status:** Approved design

**Date:** 2026-07-21

**Product URL:** `https://books.pkwor.com`

## 1. Product intent

Release 0.1 is a lightweight, open-source EPUB reader for browsers and mobile devices. It prioritizes private local reading, dependable recovery after reload, and restrained resource use on iOS 15 and newer.

The application imports EPUBs into a private, device-local library, retains each book until the reader deletes it, renders one spine item at a time, converts only the active chapter with OpenCC, and avoids loading chapter images until the reader explicitly requests one.

### Success criteria

- A reader can import multiple local, DRM-free EPUBs without uploading them.
- Every successfully imported book remains in the local library until the reader explicitly deletes it, subject to the browser's documented site-data controls and storage eviction behavior.
- On supported installed PWAs, an EPUB shared from another application is imported locally through the system share menu; all iPhones retain the in-app file-picker path.
- The table of contents and previous/next navigation work in paginated and vertical-scrolling modes.
- Appearance controls, night mode, and four Chinese text modes affect the active chapter.
- Each book's exact EPUB CFI is restored independently after a reload.
- Packaged chapter images do not load before the reader taps `點擊顯示圖片`.
- Leaving a chapter destroys its rendered DOM and any revealed image elements.
- The installed application works offline after its first complete visit.
- Portrait and landscape layouts remain usable on an iPhone-sized viewport.

## 2. Release boundaries

### Included

- Import and retain multiple local EPUBs in a browser-managed library.
- Resume each book independently and sort the library by recent reading activity.
- Delete a book and its reading progress after explicit confirmation.
- Receive an EPUB from the operating-system share menu where installed-PWA share targets are supported, with an in-app file-picker fallback everywhere.
- Render the EPUB table of contents.
- Paginated and vertical-scrolling reading modes.
- Font size, font family, background, and night-mode controls.
- Reading progress and exact-position recovery.
- Fullscreen where the platform permits it, with distraction-free fallback.
- Local OpenCC conversion for original, general Traditional Chinese, Hong Kong Traditional Chinese, and Taiwan Traditional Chinese.
- Tap-to-load packaged images.
- PWA installation and offline application startup.

### Excluded

- Bookmarks, highlights, notes, full-book search, cloud sync, accounts, telemetry, analytics, advertisements, and server-side conversion.
- DRM removal or support for encrypted commercial EPUB content.
- Go, Rust, a backend server, or a remote database.

Every successful import creates a new local library entry, even when the same file is imported again. Release 0.1 performs no whole-file hashing or automatic duplicate merging. This keeps imports deterministic and avoids a costly full-file identity pass on older devices; readers remain in control through explicit deletion.

## 3. Compatibility and technology

- TypeScript 7 for type checking.
- Vite and Preact for the application shell.
- EPUB.js for EPUB parsing, spine navigation, rendition, pagination, and scrolling.
- `opencc-js` for browser-local Chinese conversion.
- IndexedDB for the local EPUB library, per-book progress, share-target inbox, and settings.
- Vite PWA service worker for application assets.
- Cloudflare Pages for static hosting and `books.pkwor.com`.
- Safari/iOS 15 is the minimum compatibility target. Modern Chromium, Firefox, and current Safari are also supported.

The production output must not require unsupported iOS 15 syntax or APIs without a tested fallback. Touch targets are at least 44 by 44 CSS pixels, safe-area insets are respected, and layouts support portrait and landscape orientations.

## 4. Privacy and security invariants

1. Opening, parsing, converting, and storing a book happens in the browser.
2. The application makes no request containing EPUB bytes, extracted text, title, author, progress, settings, or local book identifiers.
3. The service worker caches built application assets only. Imported books remain in IndexedDB.
4. OpenCC dictionaries and code ship as application assets; conversion never calls a remote service.
5. EPUB scripts, inline event handlers, forms, embeds, and active content are disabled or removed before display.
6. Remote image URLs inside an EPUB are never fetched. Only resources resolved from the EPUB archive may be revealed.
7. External hyperlinks require an explicit reader action and open outside the reading iframe with safe `noopener` behavior.
8. No analytics, logging endpoint, account system, or backend is present.
9. A share-target POST is consumed by the service worker and written to IndexedDB locally; EPUB bytes must never fall through to Cloudflare Pages or another network endpoint.

## 5. Architecture

### 5.1 Application shell

Preact owns the library, file input, import status, deletion confirmation, reader chrome, table-of-contents drawer, settings sheet, error states, progress display, fullscreen action, and update notices.

The EPUB engine and OpenCC converters are lazy-loaded after the user opens or resumes a book. The library shell remains useful before those heavier chunks arrive.

### 5.2 Reader session

One `ReaderSession` owns one EPUB.js `Book`, one active `Rendition`, and the current chapter lifecycle. Its public interface is intentionally small:

```ts
interface ReaderSession {
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

type ReaderEvent =
  | { type: "location"; location: ReaderLocation }
  | { type: "status"; status: "idle" | "loading" | "error"; message?: string }
  | { type: "conversion-error"; message: string };
```

`ReaderSession` coordinates smaller units rather than implementing their internals:

- `EpubLoader` validates and opens local EPUB bytes.
- `ChapterTransformer` sanitizes active chapter markup and installs image gates.
- `ChapterConverter` restores original text and applies one OpenCC profile.
- `ProgressTracker` derives and persists the current CFI and approximate progress.
- `BookRepository` owns IndexedDB reads, writes, migration, share-inbox promotion, deletion, and quota failures.

### 5.3 Chapter lifecycle

Every chapter transition is ordered:

1. Capture and schedule persistence of the outgoing CFI.
2. Remove listeners and discard the outgoing chapter's original-text map.
3. Remove the outgoing iframe so revealed images and decoded image memory can be reclaimed.
4. Load one requested spine item.
5. Sanitize markup and remove real image sources before the chapter is inserted into the visible iframe.
6. Render the chapter.
7. Record original text nodes for this chapter only.
8. Apply the selected OpenCC converter to eligible text nodes.
9. Restore the target CFI or show the chapter start.

`ChapterTransformer` is the sole owner of security-critical markup mutation. It runs from `book.spine.hooks.content`, which receives the parsed section document before EPUB.js serializes it and assigns it to the rendition iframe. The day-one EPUB.js spike must pin this exact API against the installed version and prove the ordering with a request-level integration test. `rendition.hooks.content` is too late for image isolation because it runs after the iframe document loads. A post-render cleanup or CSS hide is insufficient because it can allow the browser to fetch or decode images first.

### 5.4 Reading modes

- `paginated` uses EPUB.js paginated flow and continuous spread disabled on narrow screens.
- `scrolled` uses vertical scrolled-document flow.
- Switching flow captures the current CFI, recreates the rendition, and displays that CFI.
- Rotation and viewport resizing follow the same capture/reflow/restore pattern.

### 5.5 Progress

The exact recovery value is the EPUB CFI reported by the rendition.

Progress shown to the reader is an inexpensive approximation:

```text
(completed spine items + current displayed page / current chapter pages)
-----------------------------------------------------------------------
                         total linear spine items
```

This avoids generating a whole-book EPUB location map. The interface labels the value as a percentage without promising a print-page equivalent.

Relocation events are persisted with a 300 ms trailing debounce. `pagehide` and `visibilitychange` trigger a best-effort immediate save. Resize and orientation bursts are coalesced with `requestAnimationFrame`, with at most one reflow and CFI restoration per animation frame.

### 5.6 Concurrency and data flow

All open, display, navigation, flow, conversion, and resize operations share a monotonic session generation. Each asynchronous completion checks that it still owns the current generation before mutating DOM, maps, state, or UI events. Starting a newer operation invalidates stale work. `destroy()` invalidates the current generation, removes listeners and maps, aborts controllable tasks, destroys the rendition, and revokes application-owned object URLs.

```text
OPEN / RESUME
=============
[File input | share inbox | selected library book]
        |
        v
   EpubLoader.validate/open
        |
        v
   BookRepository.import(Blob) or load(bookId)
        |
        +--> persist a new StoredBook + initial StoredProgress atomically
        +--> ReaderSession.open(Blob, resumeCfi?)
              +--> lazy import epubjs and selected OpenCC converter
              +--> display(resumeCfi | start)
                |
                v
         CHAPTER LIFECYCLE (single-flight generation N)

CHAPTER LIFECYCLE
=================
capture CFI -> schedule persistence
     |
discard old listeners + originalTextMap
     |
remove old iframe (revealed images leave with it)
     |
load one spine item
     |
book.spine.hooks.content -> ChapterTransformer [before serialization]
     |
render sanitized document into iframe
     |
record original text nodes for this chapter
     |
ChapterConverter.apply(mode, generation)
     |
restore CFI or chapter start
     |
ProgressTracker.onRelocated (300 ms trailing debounce)

PRIVACY BOUNDARY
================
Browser only:
  EPUB bytes, text, CFI, settings -> IndexedDB / memory
Never:
  requests containing book bytes, text, metadata, progress, or local IDs
Service worker:
  versioned app assets only; no user EPUB in Cache Storage

SHARE-TARGET IMPORT (SUPPORTED INSTALLED PWAS)
================================================
OS share sheet -> POST /share-target [multipart EPUB]
                        |
                        v
             service worker intercepts locally
                        |
                 validate + stage Blob
                        |
                        v
             IndexedDB shareInbox entry
                        |
          local redirect /?share-import=<id>
                        |
                        v
             app validates EPUB metadata
                        |
             atomic promote + delete inbox
                        |
                        v
              library row / open reader

Network boundary: the POST body has no server fallback.
```

## 6. Chinese conversion

```ts
type ConversionMode = "original" | "traditional" | "hong-kong" | "taiwan";
```

The product mapping is:

| Interface label | Mode | OpenCC conversion |
| --- | --- | --- |
| 原文 | `original` | None |
| 一般繁體 | `traditional` | Simplified to general Traditional (`s2t`) |
| 香港繁體 | `hong-kong` | Simplified to Hong Kong Traditional (`s2hk`) |
| 台灣繁體 | `taiwan` | Simplified to Taiwan Traditional with phrases (`s2twp`) |

Only text nodes in the active chapter are processed. Script, style, code, preformatted content, SVG metadata, and non-visible nodes are excluded.

The converter restores every active text node from its chapter-local original-text map before applying another profile. Conversion is therefore never chained. Navigating away drops the map and converter work for that chapter. Converter code and dictionaries are loaded on first use and cached as PWA assets for later offline use.

If conversion fails, the original chapter text is restored, reading remains available, and the settings sheet reports the failure without blocking navigation.

Settings help text states that conversion is intended for Simplified Chinese source text and that readers should select `原文` for books already written in Traditional Chinese. Release 0.1 performs no automatic language detection.

## 7. Image gating

Before a chapter reaches the visible iframe, `img`, `picture/source`, and SVG `image` references are transformed:

- Archive-local source attributes are stored in inert `data-epub-*` attributes.
- `src`, `srcset`, and SVG `href`/`xlink:href` are removed or replaced with a non-network inert value.
- Each image position receives an accessible button labelled `點擊顯示圖片`.
- The button restores only that image's validated archive-local source when activated.
- Failed image decoding changes the button to a retryable error state.

Remote, `javascript:`, and otherwise unsafe URLs are not restorable. When the chapter iframe is removed, all revealed image elements and handlers disappear with it. Any object URL created specifically by the application is revoked during teardown.

### 7.1 Sanitizer denylist

Before serialization, `ChapterTransformer` removes or neutralizes:

- `script`, `iframe`, `object`, `embed`, `form`, and `base` elements;
- every attribute whose name begins with `on`;
- `javascript:` URLs in `href`, `src`, `srcset`, `xlink:href`, and SVG references;
- remote stylesheets and remote image sources;
- `meta[http-equiv="refresh"]`;
- `srcdoc`, SVG animation elements, and SVG `foreignObject`.

EPUB.js scripted content remains disabled and the iframe remains sandboxed. Hostile HTML fixtures verify every rule. Security-critical stripping has no second post-render implementation path.

## 8. Local persistence

IndexedDB database: `books-reader`, schema version `1`.

```ts
interface StoredBook {
  id: string;
  fileName: string;
  byteLength: number;
  epub: Blob;
  title: string;
  creator?: string;
  savedAt: number;
  lastOpenedAt?: number;
}

interface StoredProgress {
  bookId: string;
  cfi?: string;
  spineHref?: string;
  approximatePercent: number;
  updatedAt: number;
}

interface ShareInboxEntry {
  id: string;
  fileName: string;
  byteLength: number;
  epub: Blob;
  receivedAt: number;
}

interface StoredSettings {
  key: "reader";
  flow: "paginated" | "scrolled";
  conversion: ConversionMode;
  fontSizePercent: number;
  fontFamily: "book" | "sans" | "system";
  background: "rice" | "white" | "sepia";
  theme: "system" | "day" | "night";
}
```

Object stores are `books` (`keyPath: id`), `progress` (`keyPath: bookId`), `shareInbox` (`keyPath: id`), and `settings` (`keyPath: key`). Import assigns a random local `bookId`; Release 0.1 does not hash the full EPUB or silently merge duplicates. After validation and metadata extraction, the book and its empty initial progress are created in one IndexedDB read-write transaction. At read time, runtime schema validation rejects malformed records and discards only the invalid book or progress record. The file-input `ArrayBuffer` is released after the retained `Blob` is handed to EPUB.js so the application does not intentionally retain a second complete copy.

The library sorts books by `lastOpenedAt` descending, followed by `savedAt` descending. Selecting a row opens that book at its own saved CFI. The overflow action exposes `Delete`; confirmation names the book and one transaction deletes both its `books` and `progress` records. Deleting the open book first destroys its `ReaderSession` and returns to the library. There is no bulk delete in Release 0.1.

The app requests persistent storage with `navigator.storage.persist()` where available and may display `navigator.storage.estimate()` information, but never claims that browser-managed storage is a normal user-visible folder or an absolute backup. Clearing website data, uninstalling the PWA, private browsing, or browser/OS eviction can remove the library. The interface explains this limitation concisely.

If IndexedDB is unavailable or quota is exceeded, a file-picker import may be read for the current session only after explicit consent. It states plainly that the book and position will not survive reload; no silent fallback claims persistence. A share-target import that cannot be durably staged fails with a local error page and never forwards EPUB bytes to the server.

## 9. Interface design

### 9.1 Visual direction

The approved daytime direction is **Ink & Jade**:

- Rice-paper reading surface.
- Deep jade navigation and primary actions.
- Amber marks the current chapter and other location cues.
- Refined Chinese-capable serif typography for book content.
- Geometric sans-serif typography for controls and metadata.

The approved night mode is **Night Library**:

- Near-black navigation and charcoal reading surface.
- Soft grey text rather than pure white.
- Amber remains the active accent.
- Layout, spacing, typography, and control positions do not change between themes.

The saved theme preference wins. With `system`, the app follows `prefers-color-scheme` and reacts to changes.

### 9.2 Screens and controls

- Library: privacy promise, persistent `匯入 EPUB` action, book count, and title-first rows showing a generated typographic glyph, title, creator, last-opened state, progress, and overflow actions.
- The approved **Reading list** layout uses no decoded EPUB cover artwork. It prioritizes 44-pixel tap targets, one-handed use, and low memory consumption on older phones.
- Reader top bar: table of contents, chapter title, appearance, fullscreen/focus, and close-book actions.
- Reader bottom bar: previous/next actions and approximate progress.
- Table of contents: drawer on portrait screens and a persistent side panel in landscape at widths of 900 CSS pixels or greater.
- Appearance sheet: font size, font family, background, day/night/system theme, flow, and four conversion modes.
- Reader chrome hides after an intentional tap in the reading surface and returns on another tap. Keyboard focus and screen-reader navigation never depend on hidden controls.

All controls use Traditional Chinese (Hong Kong) as the primary interface language for Release 0.1, with concise English where it materially improves clarity.

### 9.3 Fullscreen

The application uses the Fullscreen API when available. On iPhone Safari, where arbitrary page fullscreen may be unavailable, the same control enters distraction-free focus mode by hiding application chrome. An installed PWA uses standalone display mode for the closest platform-supported fullscreen experience.

## 10. Offline and service worker

- The build emits a web app manifest with standalone display, portrait and landscape support, theme colours, suitable icons, and a file share target for EPUBs.
- The service worker precaches versioned application assets, EPUB.js, converter code, and OpenCC data emitted by the build.
- User EPUB data is never added to Cache Storage.
- The manifest declares a `POST` `multipart/form-data` share target at `/share-target` accepting `application/epub+zip` and `.epub` files under the field name `epub`.
- The service worker intercepts that exact navigation request, validates that exactly one bounded-size EPUB candidate was supplied, stores its `Blob` in `shareInbox`, and returns a local redirect to `/?share-import=<inboxId>`. The POST body is never allowed to fall through to Cloudflare Pages.
- On launch, the app validates and opens the staged EPUB, atomically promotes it to `books` plus `progress`, removes the inbox entry, and reports success. Failed and abandoned inbox entries are removed immediately or on the next cleanup pass after 24 hours.
- Share-target availability is described as a supported-platform enhancement that normally requires PWA installation. It is not promised for iPhone/Safari; `匯入 EPUB` remains the universal path.
- A service-worker update is announced non-disruptively and activated on the next clean launch rather than reloading an active reader session.
- Offline verification must begin with one complete online visit, then reload the application with the network disabled and resume multiple retained EPUBs.

## 11. Error handling

| Failure | Required behavior |
| --- | --- |
| Invalid or corrupt ZIP/EPUB | Keep the current session intact and explain that the selected file cannot be opened. |
| DRM/encrypted content | Explain that protected EPUB files are unsupported; do not attempt circumvention. |
| IndexedDB unavailable | Offer session-only reading with an explicit persistence warning. |
| Quota exceeded | Keep the active in-memory book and explain that reload recovery is unavailable. |
| Shared file missing, multiple, wrong type, or too large | Reject it locally without a network fallback and offer `匯入 EPUB`. |
| Shared import interrupted | Preserve a valid staged inbox entry for the next launch, then expire it after 24 hours. |
| Saved data corrupt or version-incompatible | Discard only the invalid record, preserve settings when valid, and return to the library. |
| OpenCC load or conversion failure | Restore original text and keep navigation functional. |
| Image decode failure | Show a retryable inline error; do not reveal or fetch a different URL. |
| Unsupported Fullscreen API | Enter focus mode and retain an accessible exit control. |
| Rendition/reflow failure | Preserve the last confirmed CFI, return to the prior flow if possible, and show a non-destructive error. |

## 12. Performance constraints

- No full-book DOM, full-book conversion pass, or full-book locations generation.
- Only one visible spine item and one chapter-local original-text map.
- Images remain source-free until explicitly revealed.
- EPUB.js and OpenCC are lazy-loaded after open/resume intent.
- Reader relocation writes are debounced.
- Repeated resize events are coalesced before reflow.
- Production builds report compressed chunk sizes. The initial library shell target is at most 150 KiB gzip; larger EPUB and OpenCC assets live in lazy chunks.
- Long tasks during an ordinary chapter transition on the fixture EPUB should stay below 200 ms on desktop test hardware; real-device iPhone checks remain the authority for perceived responsiveness.
- Conversion is measured on the fixture and a large-chapter sample. If a conversion task exceeds 200 ms, text nodes are processed in generation-checked batches against a detached document and committed only after the complete chapter succeeds, preventing visible half-converted content.

## 13. Testing strategy

Production behavior follows red-green-refactor. Every new behavior begins with a test that fails for the intended reason.

### Unit tests

- Conversion-mode mapping and restoration from original text.
- Image source extraction, unsafe URL rejection, placeholder creation, and source restoration.
- Progress approximation and CFI serialization.
- Settings defaults, validation, and migrations.
- IndexedDB multi-book import, per-book progress, ordering, atomic deletion, inbox promotion, expiry, and quota handling.
- Session-only fallback classification.

### Component tests

- Library reading list, import, per-book continue, delete confirmation, table-of-contents, settings, and error interfaces.
- Ink & Jade and Night Library theme selection.
- Accessible names, focus return, keyboard navigation, and 44-pixel touch targets.

### Integration tests

A small repository-owned DRM-free fixture EPUB contains multiple chapters, a nested table of contents, local images, an intentionally remote image reference, and Simplified Chinese text. Tests prove:

- Navigation renders only the selected chapter.
- No packaged or remote image request occurs before activation.
- One selected local image becomes visible after activation.
- Chapter teardown removes revealed images.
- Conversion affects the current chapter and does not compound across mode changes.
- Independent saved CFIs restore for multiple books after application reload.
- Re-importing the same file creates a distinct entry without replacing existing progress.
- Deleting one book removes only that book and its progress.

### Browser and PWA tests

- Playwright Chromium and WebKit.
- Portrait and landscape iPhone-sized viewports.
- Paginated and scrolling navigation.
- Online first visit followed by an offline reload.
- IndexedDB multi-book resume, focus/fullscreen fallback, rotation, and service-worker update behavior.
- Chromium installed-PWA share-target import where the test environment supports installation, plus a service-worker integration test proving the POST body is intercepted and never reaches the network.
- Manual Safari/iPhone validation when a real device is available; automated WebKit is useful evidence but is not represented as proof of physical-device behavior.

### Release gates

- Type checking with TypeScript 7.
- Unit, component, integration, and browser suites pass from a clean checkout.
- Production build succeeds and bundle-size targets are checked.
- Generated manifest and service worker pass a PWA audit.
- The Cloudflare Pages preview is checked for HTTPS, offline startup, security headers, responsive layout, and absence of unexpected network requests.
- `implementation-notes.html` records the final behavior, decisions, and fresh verification evidence.

## 14. Deployment

Cloudflare Pages serves the static Vite build. The repository includes required Pages headers and redirect configuration, but no Worker, Function, database, or backend route.

### 14.1 Security headers

`public/_headers` ships at least `X-Content-Type-Options: nosniff`, a strict referrer policy, and a Content Security Policy that denies unexpected connection endpoints and is compatible with the verified EPUB.js iframe/blob behavior. The initial policy starts from `default-src 'self'`; any required `blob:` or `data:` allowances are limited to the narrow directives proven by the EPUB.js spike. `connect-src` contains no analytics or application backend. The final tested policy and its rationale are recorded in `implementation-notes.html`.

The release process is:

1. Run all local release gates.
2. Publish the source to a public GitHub repository under an open-source license.
3. Deploy the production build to a Cloudflare Pages preview.
4. Verify the preview, including offline behavior and network privacy.
5. Attach `books.pkwor.com` and verify HTTPS, manifest scope, service-worker scope, and the live application.

Deployment credentials and DNS ownership are external prerequisites. Their absence does not justify weakening local release verification or claiming that the live domain has been verified.

## 15. Decisions and trade-offs

- EPUB.js is preferred over a custom renderer because Release 0.1 needs reliable EPUB navigation and both flow modes without rebuilding the EPUB layout stack.
- The referenced `stoneapptech/epub_convert` project informs conversion intent only; its Python/Flask server architecture is deliberately not reused.
- Retaining every imported book meets the library requirement; explicit deletion and honest browser-storage messaging keep ownership understandable.
- Duplicate imports remain separate entries. This avoids full-file hashing cost and any ambiguous silent merge behavior.
- The title-first Reading list is preferred over decoded cover images for clarity, accessibility, and old-device memory use.
- Web Share Target is progressive enhancement for supported installed PWAs. File-picker import remains the iPhone-compatible baseline.
- Approximate spine-based progress avoids the CPU and memory cost of generating whole-book locations.
- Pre-render image source removal is more complex than CSS hiding but is required to guarantee lazy image loading.
- iOS focus mode is an explicit platform fallback, not a claim that mobile Safari exposes arbitrary fullscreen.

## 16. Eng review follow-ups (2026-07-21)

Full write-up: `docs/superpowers/specs/2026-07-21-pwa-epub-reader-eng-review.md`.

Mandatory engineering constraints before claiming implementation complete:

1. **Pre-display image isolation** — pin `book.spine.hooks.content` on the installed EPUB.js version; integration tests must prove zero image network requests before tap-to-reveal.
2. **Session generation / single-flight navigation** — ignore stale async work; `destroy()` aborts and revokes object URLs.
3. **Sanitizer denylist (or allowlist)** — neutralize script, iframe, object, embed, form, base, inline handlers, javascript: URLs, remote stylesheets, meta refresh, in addition to image gating.
4. **Atomic book identity** — use a generated `bookId` and one transaction per imported `Blob` plus initial progress; progress is keyed per book and no full-file hashing is required.
5. **ReaderSession UI events** — subscribe API for location, status/errors, conversion failure, persistence mode.
6. **Security headers** — Pages `_headers` with nosniff, strict referrer policy, and a documented CSP compatible with EPUB.js iframes and zero unexpected connect-src.
7. **Architecture diagrams** — open/resume, chapter lifecycle, and privacy boundary (see eng review §A7).

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | — | — |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | issues_open | 16 issues, 4 critical gaps |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |

**UNRESOLVED:** 2 non-blocking (final CSP string after spike and the user-facing maximum EPUB size, which will be set after an IndexedDB/device spike).
**VERDICT:** ENG REVIEW CONSTRAINTS INCORPORATED AND EXTENDED FOR MULTI-BOOK STORAGE — implementation must prove the hook, concurrency, sanitizer, persistence, share-target interception, and performance behavior through the required tests. Design review remains recommended after the first working UI. CEO review is optional because product scope is already tightly constrained.
