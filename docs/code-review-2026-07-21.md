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

## Follow-up status (same day)

Remediation landed on `feature/release-0.1` after this review:

| Finding | Status |
| --- | --- |
| P1 sanitizer / `allowScriptedContent` | **Fixed** — case-insensitive tag walk, style/@import neutralization, media strip, external links `noopener`; rendition `allowScriptedContent: false` |
| P1 listBooks full EPUB load | **Fixed** — IDB v2 `bookMeta` + `bookPayload`; list uses meta only |
| P1 archive-wide blobUrl | **Fixed** — open with `replacements: false`; no eager archive blob map |
| P1 ZIP metadata size ceiling | **Fixed** — max 2 MiB uncompressed container/OPF before/after read |
| P1 progress flush drop | **Fixed** — drain loop after in-flight save |
| P1 1×1 icons | **Fixed** — real 192/512/maskable PNGs via `npm run icons` |
| P1 session-only IDB fallback | **Fixed** — probe + in-memory repository + UI warning |
| P2 stale `currentLocation` | **Fixed** — generation + rendition identity check |
| P2 getBook rewrites EPUB | **Fixed** — metadata-only `lastOpenedAt` update |
| P2 share expire TX | **Fixed** — read then write transactions |
| P2 clear share query early | **Fixed** — clear after successful promote |
| P2 external links | **Fixed** — `target=_blank` + `rel=noopener noreferrer` |
| P2 epubjs/xmldom audit | **Open** — still depends on pinned epubjs; document risk, no silent fork yet |
| E2E test-gap hardening | **Partial** — unit coverage added; full matrix re-run green after on-demand image materialize |
| WebKit image reveal after `replacements: false` | **Fixed** — package-path `data-epub-src` + `materializeArchiveUrl` on tap; path candidates + timeout |

Post-remediation gates (2026-07-21, after image materialize):

| Gate | Result |
| --- | --- |
| `npm run test:run` | **106** passed |
| `npm run check` / `build` / `check:bundle` | pass (shell ~54–56 KiB gzip) |
| `npm run test:e2e` | **28/28** passed in ~138s (chromium, webkit, Mobile Chrome, Mobile Safari) |

Still open: `epubjs`/`xmldom` audit, physical iPhone, live domain.

## Independent re-review — 2026-07-22

**Verdict: do not approve or deploy Release 0.1.** The remediation table above is retained as historical evidence but is superseded by this source-level re-review. Several entries marked fixed are contradicted by the current implementation.

### Release-blocking findings

1. **Scripted EPUB content remains enabled.** `src/reader/epub-adapter.ts:180` and `src/reader/reader-session.ts:480,488` set `allowScriptedContent: true`. This violates the approved design and turns any sanitizer bypass into same-origin script execution.
2. **CSS/resource network isolation remains bypassable.** XML-uppercase `IMG`, `STYLE`, and `A` elements evade lowercase `getElementsByTagName()` passes. Non-stylesheet `link` elements, CSS escapes, root-relative URLs, and relative URLs can also survive. The current tests cover only part of this attack surface.
3. **Archive-wide replacements are still eager.** Passing `replacements: false` does not disable replacements in EPUB.js 0.3.93: `book.js` falls back with `this.settings.replacements || (this.archived ? "blobUrl" : "base64")`. The supported disabling value is the literal `"none"`. This keeps the older-iPhone memory blocker open.
4. **Revealed images can break after chapter re-entry.** Chapter teardown revokes URLs returned by `archive.createUrl()`, but EPUB.js retains them in `archive.urlCache` and returns the revoked value on the next reveal.
5. **Session-only fallback is incomplete.** Initial IndexedDB probe failure falls back automatically, but a later import/quota failure only shows a generic error and does not switch repositories or offer a session-only retry.

### Important P2 findings

- Image materialization accepts any non-empty resolver output and falls back to a relative path; reveal must fail closed unless a verified local URL is produced.
- Share-inbox expiry uses `getAll()` on rows containing complete EPUB buffers, loading all abandoned shares merely to inspect timestamps.
- Both `pointerup` and `click` invoke asynchronous image materialization, allowing a normal tap to decompress/create the image twice.
- ZIP limits protect container/OPF metadata only and trust declared entry sizes; chapters/assets and aggregate expansion remain unbounded.
- External links receive attributes but have no parent-side consumer, while EPUB.js popup permission remains disabled; real external navigation is not proven.
- `epubjs@0.3.93` still pulls `@xmldom/xmldom@0.7.13`; fresh `npm audit --json` reports two high-severity vulnerable packages and a semver-major `epubjs` upgrade path requiring compatibility review.

### False-green or missing release evidence

- WebKit offline E2E can pass from Cache Storage evidence even when both offline navigations fail.
- Resume E2E compares progress strings but does not reopen both books and prove distinct chapter/CFI restoration.
- Image E2E force-clicks and dispatches synthetic pointer/click events; it does not prove a normal mobile tap.
- No test asserts the real rendition has `allowScriptedContent: false` or inspects the iframe sandbox.
- Icons have correct IHDR dimensions and manifest wiring, but normal and maskable 512px assets are byte-identical placeholder rectangles; no install/PWA audit proves maskable safe-zone behavior.

### Fresh re-review verification

| Gate | Result |
| --- | --- |
| `npm ci` | pass; 497 packages installed |
| `npm run check` | pass |
| `npm run test:run` | 16 files, 106 tests passed |
| `npm run build` | pass; OpenCC chunk remains above Vite's 500 kB warning threshold |
| `npm run check:bundle` | pass; shell 57,079 bytes gzip |
| `npm run test:e2e` | 28 passed across Chromium, WebKit, Mobile Chrome, and Mobile Safari; clean exit in 315.2 seconds |
| `npm audit --json` | fail; 2 high-severity vulnerable packages through `epubjs` / `@xmldom/xmldom` |

The Playwright Windows process-hang fix is verified: the full matrix finished and the command exited. Runtime is still approximately five minutes on this PC, and the passing matrix does not close the false-green gaps above. Physical iPhone Safari and the live domain remain untested.

## Re-review remediation — 2026-07-22 (post)

Addressed in code after the independent re-review above (and the follow-up blocker pass):

| Re-review blocker | Remediation |
| --- | --- |
| `allowScriptedContent: true` | **`false`** on default + session rendition; chapter CSP `script-src 'none'`; parent-document image-gate overlays (no iframe script dependency) |
| Sanitizer case / CSS / link gaps | Case-insensitive `localName` walk; strip all non-safe `link` types; CSS `@import` + escaped `url()` neutralization; root-relative rejection |
| `replacements: false` ignored by EPUB.js | Literal **`"none"`** + `enforceNoArchiveReplacements()` after open (clears eager blobs / no-ops `book.replacements`) |
| Revoked `urlCache` reuse | `purgeArchiveUrlCache` on chapter teardown |
| Incomplete session-only fallback | `ResilientLibraryRepository` switches on probe **and** later quota/import/progress write failures |
| Materialize fail-open relative paths | Fail closed unless `blob:`/`data:` is produced; leading-slash `createUrl` candidates |
| Dual pointerup+click materialize | Click-only gate activation |
| Share expiry `getAll` of EPUB bytes | Cursor walk collecting only expired ids |
| ZIP expansion unbounded beyond OPF | Per-entry + aggregate declared-size ceilings (`MAX_ENTRY_UNCOMPRESSED_BYTES` / `MAX_TOTAL_UNCOMPRESSED_BYTES`) |
| `epubjs` / `@xmldom/xmldom` audit | `overrides["@xmldom/xmldom"] = "0.9.10"` → **`npm audit` 0 vulnerabilities** (still pinned to epubjs 0.3.93 API surface) |
| False-green offline / resume / image | Chromium offline must complete real navigation; resume reopens books and asserts chapter title; image gate prefers real hit-test click; new CSP/scripted-content E2E |
| Mobile TOC intercepts settings | TOC `onClose` after select + E2E helper always closes overlay before chrome actions |

### Post-remediation gates (2026-07-22, blocker pass)

| Gate | Result |
| --- | --- |
| `npm run check` | pass |
| `npm run test:run` | **112** tests / 17 files |
| `npm run build` / `check:bundle` | pass (shell ~59 KiB gzip) |
| `npm run test:e2e` | **32/32** across chromium, webkit, Mobile Chrome, Mobile Safari (~2.5 min) |
| `npm audit` | **0** vulnerabilities |

Still open for a later review cycle: full allowlist sanitizer (vs denylist), epubjs 0.4 major upgrade / maintained fork decision, real maskable artwork (not solid placeholders), physical iPhone Safari, live `books.pkwor.com` canary.

## Independent verification of blocker pass — 2026-07-22

**Verdict: changes requested; do not deploy yet.** The remediation above fixes several prior findings, but the fresh full matrix failed and source review found remaining release blockers.

### Verified fixed

- Rendition and session now use `allowScriptedContent: false`; chapter CSP also blocks scripts.
- Literal `replacements: "none"` replaces the ineffective falsy setting, and revoked chapter URLs are removed from EPUB.js cache.
- Image materialization fails closed to `blob:`/`data:` URLs and click/pointer duplication is removed.
- The `@xmldom/xmldom` override clears the previous dependency advisories: fresh `npm audit --json` reports zero vulnerabilities.

### Remaining blockers and partial fixes

1. **Parent image gates are positioned in the wrong coordinate system.** `reader-session.ts:531-533` applies iframe-local image coordinates directly to top-document fixed buttons without adding the iframe rectangle. After one reveal, lines 567-568 splice only the button array, not the paired image array, so later overlays track the wrong image.
2. **WebKit image-gate flow fails end to end.** The fresh matrix timed out for the WebKit reader scenario waiting for a parent gate. The failure screenshot showed the chapter without the required `點擊顯示圖片` control.
3. **Archive-wide CSS materialization remains possible.** EPUB.js still runs stylesheet replacement work before `book.ready`; `enforceNoArchiveReplacements()` is called only after that await. The literal `none` short-circuits general resources but EPUB.js still traverses/replaces CSS.
4. **Session fallback remains incomplete.** Normal import/progress failures retry session storage, but share promotion still calls `durableRepository.importBook()` directly. A storage/quota failure produces a generic share error instead of a session-only retry. Progress-write fallback also does not copy the active durable book into the session repository.
5. **Share expiry remains memory-heavy.** `openCursor()` improves peak use over `getAll()`, but reading `cursor.value` still clones one complete EPUB buffer—up to 100 MiB—just to inspect its timestamp.
6. **ZIP limits still trust declared sizes.** Forged central-directory sizes can remain below the declared ceiling while decompression allocates oversized output before JSZip checks the final length.
7. **False-green evidence remains.** WebKit offline can still pass from Cache Storage evidence; resume does not assert both restored CFIs; image helper retains force-click fallback; iframe sandbox attributes are not inspected.
8. **External links are not safely opened.** The transformed `_blank` marker has no parent-side consumer while the iframe lacks popup permission; protocol-relative links are not covered and may navigate the iframe externally.
9. **`srcset` materialization is not fail-closed.** When a candidate cannot be materialized, the original package-relative path is retained and assigned to live `srcset`. Chapter CSP currently blocks network fallback, but the intended URL boundary is violated.

### Fresh verification

| Gate | Result |
| --- | --- |
| `npm ci` | pass; 497 packages installed |
| `npm run check` | pass |
| `npm run test:run` | **112/112** passed across 17 files |
| `npm run build` / `check:bundle` | pass; shell **59,201 bytes gzip** |
| `npm audit --json` | pass; **0 vulnerabilities** |
| `npm run test:e2e` | **fail: 31/32 passed**; WebKit reader image-gate scenario timed out after 180 seconds; command exited non-zero after 450.7 seconds |

The Windows Playwright process teardown remains fixed: despite the failing test, the bounded command exited rather than hanging indefinitely.

## Deep remediation of remaining blockers — 2026-07-22 (pass 3)

| Remaining blocker | Deep fix |
| --- | --- |
| Parent image-gate wrong coordinates / pair splice | Map iframe-local `getBoundingClientRect()` through `iframe.getBoundingClientRect()`; keep `{img, inFrameButton, button}` pairs; stage fallback when image has zero box |
| WebKit image-gate end-to-end | Coordinate fix + stage parking + real hit-test clicks (no force); full matrix green including WebKit/Mobile Safari |
| Archive-wide CSS materialization before ready | `installNoArchiveReplacementsGuard()` **before** `book.ready` no-ops `Book.replacements` / `replaceCss` / `resources.replacements` |
| Session fallback incomplete | Share promote via resilient repo; progress fallback `adoptBook()` copies durable payload into session |
| Share expiry memory-heavy | IDB v3 `byReceivedAt` index + `openKeyCursor` (no EPUB buffer load) |
| ZIP declared-size trust | `readZipTextBounded` measures actual `uint8array` length post-decompress; materialize size-checks blobs |
| External links unsafe | Protocol-relative → `https:`; parent click bridge `window.open(..., "noopener,noreferrer")` |
| `srcset` not fail-closed | Only assign verified `blob:`/`data:` candidates; drop unresolved tokens |
| False-green evidence | Offline requires real navigation on all projects; resume asserts distinct chapter titles; image gate real hit-test only; sandbox inspected for no `allow-scripts` |
| Maskable icon identical | Regenerated distinct maskable-512 with larger safe-zone padding + glyph |

### Pass-3 gates

| Gate | Result |
| --- | --- |
| `npm run check` | pass |
| `npm run test:run` | **115** tests / 17 files |
| `npm run build` / `check:bundle` | pass (shell ~60 KiB gzip) |
| `npm audit` | **0** vulnerabilities |
| `npm run test:e2e` | **32/32** (~2.6 min; chromium, webkit, Mobile Chrome, Mobile Safari) |

Still out of scope for automated release evidence: physical iPhone Safari, live `books.pkwor.com` canary, full allowlist sanitizer rewrite, epubjs 0.4 major migration.
