# PWA EPUB Reader Release 0.1 Design

**Status:** Approved design

**Date:** 2026-07-21

**Product URL:** `https://books.pkwor.com`

## 1. Product intent

Release 0.1 is a lightweight, open-source EPUB reader for browsers and mobile devices. It prioritizes private local reading, dependable recovery after reload, and restrained resource use on iOS 15 and newer.

The application opens an EPUB selected by the user, keeps the file on the device, renders one spine item at a time, converts only the active chapter with OpenCC, and avoids loading chapter images until the reader explicitly requests one.

### Success criteria

- A reader can open a local, DRM-free EPUB without uploading it.
- The table of contents and previous/next navigation work in paginated and vertical-scrolling modes.
- Appearance controls, night mode, and four Chinese text modes affect the active chapter.
- The most recently opened EPUB and its exact EPUB CFI can be restored after a reload.
- Packaged chapter images do not load before the reader taps `點擊顯示圖片`.
- Leaving a chapter destroys its rendered DOM and any revealed image elements.
- The installed application works offline after its first complete visit.
- Portrait and landscape layouts remain usable on an iPhone-sized viewport.

## 2. Release boundaries

### Included

- Open a local EPUB.
- Retain and resume the most recently opened book.
- Render the EPUB table of contents.
- Paginated and vertical-scrolling reading modes.
- Font size, font family, background, and night-mode controls.
- Reading progress and exact-position recovery.
- Fullscreen where the platform permits it, with distraction-free fallback.
- Local OpenCC conversion for original, general Traditional Chinese, Hong Kong Traditional Chinese, and Taiwan Traditional Chinese.
- Tap-to-load packaged images.
- PWA installation and offline application startup.

### Excluded

- Bookmarks, highlights, notes, full-book search, cloud sync, accounts, telemetry, analytics, advertisements, server-side conversion, and a multi-book library interface.
- DRM removal or support for encrypted commercial EPUB content.
- Go, Rust, a backend server, or a remote database.

Release 0.1 retains only the most recently opened EPUB. Opening and successfully storing another EPUB replaces the previous retained book. This supplies reload recovery without quietly creating an unscoped library feature.

## 3. Compatibility and technology

- TypeScript 7 for type checking.
- Vite and Preact for the application shell.
- EPUB.js for EPUB parsing, spine navigation, rendition, pagination, and scrolling.
- `opencc-js` for browser-local Chinese conversion.
- IndexedDB for the retained EPUB, progress, and settings.
- Vite PWA service worker for application assets.
- Cloudflare Pages for static hosting and `books.pkwor.com`.
- Safari/iOS 15 is the minimum compatibility target. Modern Chromium, Firefox, and current Safari are also supported.

The production output must not require unsupported iOS 15 syntax or APIs without a tested fallback. Touch targets are at least 44 by 44 CSS pixels, safe-area insets are respected, and layouts support portrait and landscape orientations.

## 4. Privacy and security invariants

1. Opening, parsing, converting, and storing a book happens in the browser.
2. The application makes no request containing EPUB bytes, extracted text, title, author, progress, settings, or fingerprints.
3. The service worker caches built application assets only. Imported books remain in IndexedDB.
4. OpenCC dictionaries and code ship as application assets; conversion never calls a remote service.
5. EPUB scripts, inline event handlers, forms, embeds, and active content are disabled or removed before display.
6. Remote image URLs inside an EPUB are never fetched. Only resources resolved from the EPUB archive may be revealed.
7. External hyperlinks require an explicit reader action and open outside the reading iframe with safe `noopener` behavior.
8. No analytics, logging endpoint, account system, or backend is present.

## 5. Architecture

### 5.1 Application shell

Preact owns the welcome screen, file input, reader chrome, table-of-contents drawer, settings sheet, error states, progress display, fullscreen action, and update notices.

The EPUB engine and OpenCC converters are lazy-loaded after the user opens or resumes a book. The welcome shell remains useful before those heavier chunks arrive.

### 5.2 Reader session

One `ReaderSession` owns one EPUB.js `Book`, one active `Rendition`, and the current chapter lifecycle. Its public interface is intentionally small:

```ts
interface ReaderSession {
  open(source: ArrayBuffer, resumeCfi?: string): Promise<BookSummary>;
  display(target?: string): Promise<void>;
  goPrevious(): Promise<void>;
  goNext(): Promise<void>;
  setFlow(flow: "paginated" | "scrolled"): Promise<void>;
  setConversion(mode: ConversionMode): Promise<void>;
  applyAppearance(settings: AppearanceSettings): void;
  getLocation(): ReaderLocation | null;
  destroy(): void;
}
```

`ReaderSession` coordinates smaller units rather than implementing their internals:

- `EpubLoader` validates and opens local EPUB bytes.
- `ChapterTransformer` sanitizes active chapter markup and installs image gates.
- `ChapterConverter` restores original text and applies one OpenCC profile.
- `ProgressTracker` derives and persists the current CFI and approximate progress.
- `BookRepository` owns IndexedDB reads, writes, migration, and quota failures.

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

The implementation must use an EPUB.js pre-render or serialization boundary for image isolation. A post-render CSS hide is insufficient because it can allow the browser to fetch or decode images before they are hidden.

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

Relocation events are persisted with a short trailing debounce. `pagehide` and `visibilitychange` trigger a best-effort immediate save.

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

## 7. Image gating

Before a chapter reaches the visible iframe, `img`, `picture/source`, and SVG `image` references are transformed:

- Archive-local source attributes are stored in inert `data-epub-*` attributes.
- `src`, `srcset`, and SVG `href`/`xlink:href` are removed or replaced with a non-network inert value.
- Each image position receives an accessible button labelled `點擊顯示圖片`.
- The button restores only that image's validated archive-local source when activated.
- Failed image decoding changes the button to a retryable error state.

Remote, `javascript:`, and otherwise unsafe URLs are not restorable. When the chapter iframe is removed, all revealed image elements and handlers disappear with it. Any object URL created specifically by the application is revoked during teardown.

## 8. Local persistence

IndexedDB database: `books-reader`, schema version `1`.

```ts
interface StoredBook {
  key: "current";
  fingerprint: string;
  fileName: string;
  byteLength: number;
  epub: ArrayBuffer;
  title: string;
  creator?: string;
  savedAt: number;
}

interface StoredProgress {
  key: "current";
  fingerprint: string;
  cfi: string;
  spineHref: string;
  approximatePercent: number;
  updatedAt: number;
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

The SHA-256 fingerprint distinguishes a replacement book from the previous one and prevents applying stale progress to different content. The new EPUB and its initial progress are committed before the previous record is discarded.

If IndexedDB is unavailable or quota is exceeded, the reader offers session-only use. It states plainly that the book and position will not survive reload; no silent fallback claims persistence.

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

- Welcome: privacy promise, `Open EPUB`, and `Continue reading` when a valid retained book exists.
- Reader top bar: table of contents, chapter title, appearance, fullscreen/focus, and close-book actions.
- Reader bottom bar: previous/next actions and approximate progress.
- Table of contents: drawer on portrait screens and optional side panel in landscape.
- Appearance sheet: font size, font family, background, day/night/system theme, flow, and four conversion modes.
- Reader chrome hides after an intentional tap in the reading surface and returns on another tap. Keyboard focus and screen-reader navigation never depend on hidden controls.

All controls use Traditional Chinese (Hong Kong) as the primary interface language for Release 0.1, with concise English where it materially improves clarity.

### 9.3 Fullscreen

The application uses the Fullscreen API when available. On iPhone Safari, where arbitrary page fullscreen may be unavailable, the same control enters distraction-free focus mode by hiding application chrome. An installed PWA uses standalone display mode for the closest platform-supported fullscreen experience.

## 10. Offline and service worker

- The build emits a web app manifest with standalone display, portrait and landscape support, theme colours, and suitable icons.
- The service worker precaches versioned application assets, EPUB.js, converter code, and OpenCC data emitted by the build.
- User EPUB data is never added to Cache Storage.
- A service-worker update is announced non-disruptively and activated on the next clean launch rather than reloading an active reader session.
- Offline verification must begin with one complete online visit, then reload the application with the network disabled and resume the retained EPUB.

## 11. Error handling

| Failure | Required behavior |
| --- | --- |
| Invalid or corrupt ZIP/EPUB | Keep the current session intact and explain that the selected file cannot be opened. |
| DRM/encrypted content | Explain that protected EPUB files are unsupported; do not attempt circumvention. |
| IndexedDB unavailable | Offer session-only reading with an explicit persistence warning. |
| Quota exceeded | Keep the active in-memory book and explain that reload recovery is unavailable. |
| Saved data corrupt or version-incompatible | Discard only the invalid record, preserve settings when valid, and return to the welcome screen. |
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
- Production builds report compressed chunk sizes. The initial welcome shell target is at most 150 KiB gzip; larger EPUB and OpenCC assets live in lazy chunks.
- Long tasks during an ordinary chapter transition on the fixture EPUB should stay below 200 ms on desktop test hardware; real-device iPhone checks remain the authority for perceived responsiveness.

## 13. Testing strategy

Production behavior follows red-green-refactor. Every new behavior begins with a test that fails for the intended reason.

### Unit tests

- Conversion-mode mapping and restoration from original text.
- Image source extraction, unsafe URL rejection, placeholder creation, and source restoration.
- Progress approximation and CFI serialization.
- Settings defaults, validation, and migrations.
- IndexedDB retained-book replacement and fingerprint matching.
- Session-only fallback classification.

### Component tests

- Welcome, continue, open-file, table-of-contents, settings, and error interfaces.
- Ink & Jade and Night Library theme selection.
- Accessible names, focus return, keyboard navigation, and 44-pixel touch targets.

### Integration tests

A small repository-owned DRM-free fixture EPUB contains multiple chapters, a nested table of contents, local images, an intentionally remote image reference, and Simplified Chinese text. Tests prove:

- Navigation renders only the selected chapter.
- No packaged or remote image request occurs before activation.
- One selected local image becomes visible after activation.
- Chapter teardown removes revealed images.
- Conversion affects the current chapter and does not compound across mode changes.
- A saved CFI restores after application reload.

### Browser and PWA tests

- Playwright Chromium and WebKit.
- Portrait and landscape iPhone-sized viewports.
- Paginated and scrolling navigation.
- Online first visit followed by an offline reload.
- IndexedDB resume, focus/fullscreen fallback, rotation, and service-worker update behavior.
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
- Retaining one book balances reload recovery with scope and storage pressure.
- Approximate spine-based progress avoids the CPU and memory cost of generating whole-book locations.
- Pre-render image source removal is more complex than CSS hiding but is required to guarantee lazy image loading.
- iOS focus mode is an explicit platform fallback, not a claim that mobile Safari exposes arbitrary fullscreen.
