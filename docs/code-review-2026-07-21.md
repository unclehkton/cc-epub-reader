# Release 0.1 critical code review — 2026-07-21

## Verdict

**Do not approve or deploy this branch yet.** The automated gates now complete reliably, but the review found release-blocking security, memory, persistence, and PWA-installability defects that the current tests do not exercise.

## Release blockers

### P1 — Untrusted EPUB script can survive sanitization and run in a scripted iframe

- `src/reader/reader-session.ts` enables `allowScriptedContent` on the rendition.
- `src/reader/chapter-transformer.ts` removes hostile tags using lowercase `getElementsByTagName()` lookups. XHTML is XML and tag matching can be case-sensitive, so variants such as `<SCRIPT>` or namespaced active elements can survive.
- Inline `<style>` content is not fully parsed or rewritten; `@import`, `url()`, SVG references, media elements, and related fetch paths remain outside the image gate.

This conflicts with the privacy and hostile-content requirements. Disable scripted content or replace the blacklist with a namespace-aware allowlist sanitizer, then add hostile XHTML/SVG/CSS execution and network tests.

### P1 — Library listing materializes every retained EPUB

`src/library/book-repository.ts:listBooks()` calls `getAll()` on the `books` store. Each record contains the full EPUB `ArrayBuffer`, so opening the library can clone every retained book into memory. This defeats multiple-book retention on older iPhones. Store metadata separately or enumerate metadata-only records/cursors without loading payloads.

### P1 — Opening one book eagerly creates archive-wide blob replacements

`src/reader/reader-session.ts` opens EPUB.js with `replacements: "blobUrl"`. That can create replacement URLs for the full archive, conflicting with the one-chapter-at-a-time and tap-to-load-image memory requirements. Prove and enforce chapter-scoped resource creation and revoke URLs on chapter exit.

### P1 — ZIP metadata reads have no decompressed-size ceiling

`src/library/epub-validator.ts` calls `containerFile.async("text")` and `packageFile.async("text")` without checking their uncompressed sizes. A small compressed EPUB can expand these entries enough to exhaust memory. Reject oversized container/OPF entries before decompression and test ZIP bombs.

### P1 — Progress written during an in-flight save can be lost

`src/reader/progress-tracker.ts:flush()` waits for an existing `flushPromise` and returns without flushing the newer `pending` snapshot. A pagehide/close during that interval can persist a stale reading position. Drain pending state after the active write and add a deferred-save regression test.

### P1 — Declared PWA icons are 1×1 pixels

`public/icons/icon-192.png`, `icon-512.png`, and `maskable-512.png` are all 70-byte 1×1 PNGs despite their manifest roles. This can prevent or degrade installation and the share-target app identity. Replace them with genuine 192×192 and 512×512 artwork, including a correctly padded maskable icon, and validate manifest assets.

### P1 — No required session-only fallback when IndexedDB is unavailable

Repository failures surface as generic library errors. The approved design requires a clear session-only fallback for private mode, quota, or unavailable IndexedDB. Add the fallback and test an IndexedDB-open failure.

## Important P2 findings

- `reader-session.ts` applies asynchronous `currentLocation()` results without confirming the rendition/generation is still current, allowing a stale chapter to overwrite location state.
- `book-repository.ts:getBook()` copies and rewrites the complete EPUB merely to update `lastOpenedAt`.
- `sw/share-import.ts:expireShareInbox()` awaits `getAll()` and then issues deletes on the same transaction; WebKit may deactivate that transaction between awaits.
- `app.tsx` clears `share-import` from the URL before promotion succeeds, so a transient failure can strand a valid staged share with no retry path.
- External links are left as direct iframe navigation rather than an explicit safe action with opener isolation.
- `epubjs@0.3.93` brings `@xmldom/xmldom@0.7.13`, which `npm audit` reports under high-severity advisories with no automatic fix. A maintained fork/replacement or isolated mitigation decision is required.

## Test gaps that caused false confidence

- The privacy test watches external requests but does not cover same-origin EPUB-triggered requests, inline CSS, SVG, media, or actual script execution.
- The offline test permits WebKit/Mobile Safari to pass from Cache Storage evidence when offline navigation itself fails.
- The resume test does not reopen both retained books and prove distinct chapter/CFI restoration end to end.
- The image test force-clicks/synthetically dispatches, so it does not prove that the real placeholder is tappable through normal hit testing.

## Playwright hang: root cause and correction

The browsers and test collection were healthy. Chromium and WebKit launched directly in about one second, and all 28 tests collected in 1.6 seconds. The repeatable hang occurred before workers started when Playwright's Windows `webServer` hook owned the preview process; a pre-existing preview made the same test pass.

The runner now:

1. builds before Playwright starts;
2. starts Vite from a bounded global setup instead of the hanging `webServer` hook;
3. fails preview/browser startup after 30 seconds with an actionable browser-install command;
4. tears down the exact preview PID after the suite.

Fresh result: all 28 projects/scenarios passed and the process exited normally in 156.9 seconds; port 4173 was released.

## Fresh verification

| Gate | Result |
| --- | --- |
| `npm run check` | pass |
| `npm run test:run` | 16 files, 103 tests passed |
| `npm run build` | pass |
| `npm run check:bundle` | pass; shell 55,123 bytes gzip |
| `npm run test:e2e` | 28 passed; clean exit in 2.5 minutes |
| Browser preflight | direct Chromium and WebKit launch/close pass |
| Preview teardown | port 4173 released |

Physical iPhone Safari and the live `books.pkwor.com` deployment were not tested.
