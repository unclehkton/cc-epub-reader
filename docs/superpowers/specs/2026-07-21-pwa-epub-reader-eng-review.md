# Eng Review — PWA EPUB Reader Release 0.1

**Skill:** `/plan-eng-review`  
**Date:** 2026-07-21  
**Branch:** `main` @ `6bff6d4`  
**Plan:** `docs/superpowers/specs/2026-07-21-pwa-epub-reader-design.md`  
**Mode:** FULL_REVIEW (non-interactive deliverable for Codex handoff)  
**Scope decision:** Proceed with **full 0.1 product scope as written**. Do not thin features. Fix precision gaps in the plan/implementation notes, not by cutting success criteria.

**STATUS:** DONE_WITH_CONCERNS — plan is strong and implementable; several architecture specs must be locked before coding so Codex does not invent unsafe defaults.

---

## For Codex — how to use this document

1. Treat the design doc as product/architecture source of truth.
2. Treat **this eng review** as mandatory engineering constraints and test requirements layered on top.
3. Apply every item marked **MUST** before claiming a slice done.
4. Items marked **SHOULD** are strong defaults; only skip with a written note in `implementation-notes.html`.
5. Do **not** re-open product exclusions (library, cloud, DRM crack, backend).

---

## Step 0 summary

| Check | Result |
| --- | --- |
| Existing code | Greenfield — only design + brainstorm assets |
| Scope creep | Low — exclusions already disciplined |
| Complexity | High file count expected for greenfield; module split is justified |
| Completeness | High product completeness; gaps are eng precision |
| Distribution | Cloudflare Pages + open GitHub covered; live domain is external |

**What already exists:** nothing to reuse. Scaffold Vite + Preact + Vitest + Playwright from scratch.

---

## 1. Architecture findings

### A1 [P0] (confidence: 9/10) — Image isolation boundary is required but unspecified

**Problem:** §5.3 / §7 require pre-render source removal. CSS hide is correctly rejected. The plan never names the EPUB.js integration point, so implementers may hook too late (after network/decode).

**MUST:**
- Use a content/serialize hook that runs **before** the chapter document is committed to the visible iframe (EPUB.js: section/rendition `hooks.content` / serialize path — spike and pin the exact API in code comments).
- Integration test asserts: for the fixture EPUB, **zero** requests for packaged image URLs and remote image URLs until the reader activates a local image control.
- Remote / `javascript:` / unsafe URLs never become restorable `src` values.

**Default for Codex:** Implement `ChapterTransformer` as the single owner of markup mutation; call it only from the pre-display hook. No second “cleanup after render” path for security-critical stripping.

---

### A2 [P1] (confidence: 8/10) — EPUB.js maintenance / package pin

**Problem:** Design prefers EPUB.js for CFI + paginated + scrolled. Upstream maintenance of `futurepress/epub.js` is historically weak; forks and **foliate-js** exist. Switching mid-flight is expensive (especially CFI).

**MUST:**
- Pin exact `epubjs` version in `package.json`.
- Day-1 spike (same PR as scaffold or first reader PR): open fixture, paginate, scroll, CFI restore, content hook for image gate.
- Document escape hatch in `implementation-notes.html`: if hook or iOS 15 behavior fails, evaluate maintained fork before rewriting on foliate-js (foliate drops CFI parity — product impact).

**RECOMMENDATION:** Stay on EPUB.js for 0.1 after successful spike. Do not start on foliate-js unless spike fails.

---

### A3 [P0] (confidence: 9/10) — Chapter transition concurrency / stale async

**Problem:** Lifecycle steps 1–9 are ordered but not concurrency-safe. Rapid `goNext`, flow switch mid-display, or open-while-navigating can apply conversion/maps to the wrong chapter or leave two iframes alive.

**MUST:**
- Introduce a monotonic `generation` (or `AbortController`) on `ReaderSession`.
- Every async step after `display` / `goNext` / `goPrevious` / `setFlow` / `setConversion` checks generation before mutating DOM or maps.
- `destroy()` aborts in-flight work and clears maps/listeners/object URLs.

**Test:** hammer next/prev and flow toggle; assert only one live chapter iframe and map for the final target.

---

### A4 [P1] (confidence: 8/10) — Fingerprint strategy for large EPUBs

**Problem:** SHA-256 over full `ArrayBuffer` on main thread can freeze UI on multi‑tens‑of‑MB books. Fingerprint is also the key that invalidates stale progress — correctness matters.

**MUST:**
- Hash off main thread (`crypto.subtle.digest` in a Worker) **or** stream/chunk hash before blocking UI.
- Commit order remains: new book + initial progress written before discarding previous record.
- If hash fails, refuse silent resume with wrong book; session-only or re-open is OK.

**SHOULD:** Cap “supported for resume” size in UI messaging if quota/hash cost is extreme; still allow session-only open when possible.

---

### A5 [P1] (confidence: 8/10) — Security headers / CSP not specified

**Problem:** Privacy invariants ban sending book bytes, but Pages `_headers` are only mentioned generically. EPUB.js iframes often need careful CSP (`blob:`, maybe `data:`). Wrong CSP either breaks reading or leaves XSS surface from EPUB HTML.

**MUST:** Ship `public/_headers` (or Pages config) with at least:
- `X-Content-Type-Options: nosniff`
- Referrer policy strict-origin-when-cross-origin (or stricter)
- A documented CSP that **disallows** unexpected connect-src endpoints (no analytics hosts)
- Frame/sandbox policy consistent with image gating and disabled EPUB scripts

**MUST:** Document the CSP decision in `implementation-notes.html` after real EPUB.js behavior is known (spike may adjust).

---

### A6 [P2] (confidence: 7/10) — Memory: full book in RAM + IndexedDB

**Problem:** `StoredBook.epub: ArrayBuffer` plus EPUB.js in-memory book doubles large payloads. iOS Safari pressure is real.

**SHOULD:**
- Prefer `Blob` in IndexedDB if it simplifies memory release.
- Revoke any object URLs on chapter teardown and session destroy.
- After successful store, avoid retaining a second full copy in the file-input path.

**Not blocking 0.1**, but note expected max book size in release notes.

---

### A7 [P1] (confidence: 9/10) — Missing architecture diagrams in the plan

**Problem:** Chapter lifecycle is prose-only. Skill and maintainability want ASCII for data flow and state.

**MUST for plan/impl notes:** Include diagrams below (copy into design or `implementation-notes.html`).

```text
OPEN / RESUME
=============
[File input | IDB current book]
        |
        v
   EpubLoader.validate/open
        |
        v
   ReaderSession.open(ArrayBuffer, resumeCfi?)
        |
        +--> BookRepository.save(book) [if persist]
        +--> lazy import epubjs + opencc
        +--> display(resumeCfi | start)
                |
                v
         CHAPTER LIFECYCLE (single-flight generation N)

CHAPTER LIFECYCLE
=================
capture CFI (out) -> schedule persist
     |
discard old listeners + originalTextMap
     |
remove old iframe (images die with it)
     |
load spine item
     |
ChapterTransformer.sanitize + image gates  [BEFORE visible commit]
     |
render into iframe
     |
record original text nodes (chapter-local)
     |
ChapterConverter.apply(mode)
     |
restore CFI or chapter start
     |
ProgressTracker.onRelocated (debounced)

PRIVACY BOUNDARY
================
Browser only:
  EPUB bytes, text, CFI, settings --> IndexedDB / memory
Never:
  fetch(book bytes | title | progress | fingerprints to app backend)
Service worker:
  app assets only (no user EPUB in Cache Storage)
```

---

### A8 [P2] (confidence: 7/10) — TypeScript “7”

**Problem:** Plan states TypeScript 7. Toolchain must resolve on clean checkout.

**MUST:** Pin a real, installable `typescript` version. If TS 7 is unavailable in the environment, use the newest stable that still meets iOS 15 emit targets and note the deviation.

---

## 2. Code quality findings

### Q1 [P1] (confidence: 9/10) — `ReaderSession` public API is too small for UI

**Problem:** Interface has open/display/nav/settings getters but no subscription model. Preact chrome needs location, errors, loading, conversion failure, progress percent.

**MUST extend (or companion) API:**

```ts
// Minimal additions — keep one session owner
type ReaderEvent =
  | { type: "location"; location: ReaderLocation }
  | { type: "status"; status: "idle" | "loading" | "error"; message?: string }
  | { type: "conversion-error"; message: string };

// subscribe(listener): () => void
// getPersistence(): "durable" | "session-only"
```

Bias: explicit events over Preact reaching into EPUB.js.

---

### Q2 [P0] (confidence: 9/10) — Sanitizer rules incomplete relative to threat model

**Problem:** §4.5 lists scripts, handlers, forms, embeds. EPUB HTML can also abuse: `<base href>`, external `<link rel=stylesheet>`, `<object>`, `<iframe>`, `<meta http-equiv=refresh>`, SVG animation / foreignObject, `srcdoc`.

**MUST deny or neutralize before display:**
- script, iframe, object, embed, form, base
- inline event handlers (all `on*`)
- javascript: URLs in href/src/xlink:href
- remote stylesheets and remote images (images already gated)
- meta refresh

**SHOULD:** Prefer allowlist of tags/attrs for chapter body if maintainable; otherwise aggressive denylist + tests with hostile fixture fragments.

---

### Q3 [P1] (confidence: 8/10) — Conversion applies only to Simplified→Traditional paths

**Problem:** Modes are s2t / s2hk / s2twp. Books already in Traditional Chinese should be read as `original`. Plan implies this via mapping table but does not state UX copy.

**SHOULD:** Settings help text: conversion is for Simplified source text; use 原文 for already-Traditional books. No auto language detect in 0.1.

---

### Q4 [P1] (confidence: 8/10) — Persistence atomicity and corrupt records

**Problem:** “Commit new before discard old” is correct. Need explicit transaction boundaries and corrupt-record recovery tests.

**MUST:**
- IDB writes for replacement book use a clear sequence; never leave progress fingerprint pointing at missing book.
- On open: if progress fingerprint ≠ book fingerprint, discard progress only.
- Schema validation at read time (not only TypeScript types).

---

### Q5 [P2] (confidence: 7/10) — Debounce constants unspecified

**MUST pick and document:**
- relocation persist debounce: **250–400 ms** trailing
- resize coalesce: **rAF or ≤150 ms**
- `pagehide` / `visibilitychange`: flush immediately (as plan says)

---

## 3. Test review

### Framework (greenfield — establish)

| Layer | Tool |
| --- | --- |
| Unit / component | Vitest + Preact Testing Library |
| Integration | Vitest + fixture EPUB + mocked/real DOM as needed |
| Browser / PWA | Playwright Chromium + WebKit |
| Types | `tsc --noEmit` |
| Bundle | Vite build size check script |

### CODE PATH COVERAGE (plan → required tests)

```text
CODE PATH COVERAGE
===========================
[+] EpubLoader
    ├── open valid DRM-free EPUB — [GAP] unit+integration
    ├── corrupt ZIP — [GAP]
    ├── encrypted/DRM signal — [GAP] message, no circumvention
    └── empty / non-epub mime — [GAP]

[+] ChapterTransformer
    ├── strip img/srcset/svg image — [GAP]
    ├── reject remote + javascript URLs — [GAP]
    ├── placeholder button a11y name 點擊顯示圖片 — [GAP]
    ├── restore single local image on activate — [GAP]
    ├── decode failure -> retry UI — [GAP]
    └── hostile: script/base/iframe/onerror — [GAP] [CRITICAL]

[+] ChapterConverter
    ├── original passthrough — [GAP]
    ├── s2t / s2hk / s2twp from originals — [GAP]
    ├── mode switch never chains — [GAP]
    ├── excludes script/style/code/pre — [GAP]
    └── converter failure restores original — [GAP]

[+] ProgressTracker
    ├── approx percent formula edges (0, mid, last) — [GAP]
    ├── CFI persist debounce — [GAP]
    ├── pagehide flush — [GAP]
    └── fingerprint mismatch discard — [GAP]

[+] BookRepository
    ├── replace current book atomic — [GAP]
    ├── quota exceeded -> session-only — [GAP]
    ├── IDB unavailable -> session-only — [GAP]
    └── corrupt record discard — [GAP]

[+] ReaderSession
    ├── open + display + CFI resume — [GAP] [→E2E]
    ├── goNext/goPrevious single-flight — [GAP]
    ├── setFlow recreate + CFI — [GAP]
    ├── generation cancel stale work — [GAP]
    └── destroy revokes URLs / clears maps — [GAP]

USER FLOW COVERAGE
===========================
[+] Welcome open EPUB — [GAP] [→E2E]
[+] Continue reading after reload — [GAP] [→E2E]
[+] TOC jump — [GAP] [→E2E]
[+] Appearance + night mode — [GAP]
[+] Conversion modes on active chapter — [GAP] [→E2E]
[+] Tap reveal one image only — [GAP] [→E2E]
[+] Offline after first visit + resume — [GAP] [→E2E]
[+] Focus mode when fullscreen missing — [GAP]
[+] No book-data network requests while reading — [GAP] [→E2E]
[+] Double-open second EPUB replaces first — [GAP]
[+] Rapid next spam — [GAP]
[+] Rotate portrait/landscape — [GAP] [→E2E]

─────────────────────────────────
COVERAGE (pre-implementation): 0/N — all paths are GAP by definition
GAPS to add to implementation plan: all above are required for release gates
─────────────────────────────────
```

### REGRESSION rule
Greenfield — no legacy regressions. Treat **privacy network assertions** and **image zero-request before tap** as release-critical from day one (equivalent to regression priority).

### Fixture EPUB requirements (expand design §13)
Repository fixture **MUST** include:
- ≥2 spine items, nested TOC
- ≥1 local packaged image
- ≥1 remote `http(s)` image reference (must never load)
- Simplified Chinese body text suitable for OpenCC
- Hostile fragment chapter or separate HTML unit fixtures for sanitizer

---

## 4. Performance findings

### P1 [P1] (confidence: 8/10) — OpenCC chapter cost vs 200 ms budget

**Problem:** Full-chapter text walk + OpenCC can exceed 200 ms on large chapters.

**MUST:**
- Measure on fixture and one “large chapter” sample.
- If over budget: yield between node batches (`scheduler` / chunk with generation check) without visible half-converted flicker (convert off-DOM clone or apply atomically per chapter).

### P2 [P2] (confidence: 7/10) — Welcome shell 150 KiB gzip

**MUST:** Fail CI if welcome entry chunk exceeds 150 KiB gzip. EPUB.js + OpenCC must be dynamic `import()` only after open/resume intent.

### P3 [P2] (confidence: 7/10) — Resize / orientation storms

**MUST:** Coalesce resize; single reflow+CFI restore per burst (plan states this; implement explicitly).

---

## 5. Failure modes (production)

| Path | Failure | Test? | Handling in plan? | User visible? | Critical gap? |
| --- | --- | --- | --- | --- | --- |
| Image gate late hook | Images fetch before hide | Required | Partial (intent only) | Silent privacy break | **YES until hook pinned + test** |
| Stale navigation | Wrong chapter conversion | Required | No | Confusing text | **YES until generation token** |
| IDB quota | Save fails mid-replace | Required | Yes | Warning | No if implemented |
| OpenCC fail | Converter throw | Required | Yes | Settings message | No |
| SW update mid-read | Reload drops place | Playwright | Yes (defer activate) | Possible | Mitigate per plan |
| Fullscreen unsupported | API missing | Component | Yes focus mode | OK | No |
| Hostile EPUB script | XSS in iframe | Unit+fixture | Partial | Exploit | **YES until sanitizer list complete** |
| Large file hash | UI freeze | Perf | No | Jank | **YES until off-main-thread hash** |
| Fingerprint mismatch | Wrong CFI applied | Unit | Yes intent | Jump wrong place | Covered if tests land |

**Critical gaps to close in plan/impl before “done”:** late image hook, navigation generation, sanitizer completeness, large-file hashing.

---

## 6. NOT in scope (explicit)

| Item | Why deferred |
| --- | --- |
| Multi-book library UI | Product exclusion; single `current` key only |
| Bookmarks / highlights / notes / full-text search | 0.1 exclusion |
| Cloud sync / accounts / telemetry / ads | Privacy invariants |
| DRM removal | Legal/product exclusion |
| Backend / Workers / D1 | Static Pages only |
| Auto language detection for conversion | Complexity; user picks mode |
| foliate-js migration | Only if EPUB.js spike fails |
| Print / export / share sheet | Not in success criteria |
| Android/iOS native shells | PWA only |
| Live domain DNS if credentials missing | External; do not fake verification |

---

## 7. Recommended plan text patches (Codex or human should apply)

Add a short **§5.6 Concurrency** to the design:

> All navigation, flow changes, conversion, and open operations share a monotonic session generation. Async completions for older generations are ignored. `destroy()` aborts work and revokes object URLs.

Add **§7.1 Sanitizer denylist** (or allowlist) enumerating tags/attrs from Q2.

Add **§8.1 Fingerprinting** off-main-thread hash requirement.

Add **§14.1 Security headers** CSP placeholder + nosniff.

Add architecture ASCII from A7 into §5.

Pin dependency versions in an **Implementation prerequisites** note once scaffold exists.

---

## 8. Worktree parallelization

| Step | Modules | Depends on |
| --- | --- | --- |
| S0 Scaffold (Vite/Preact/TS/Vitest/PWA/Playwright) | repo root, CI | — |
| S1 Fixture EPUB + hostile HTML fixtures | `fixtures/` | — |
| S2 BookRepository + settings/progress types | `src/storage/` | S0 |
| S3 ChapterTransformer + sanitizer tests | `src/reader/transform/` | S0, S1 |
| S4 ChapterConverter + OpenCC lazy load | `src/reader/convert/` | S0 |
| S5 ReaderSession + EpubLoader + ProgressTracker | `src/reader/` | S2–S4, spike |
| S6 Preact shell UI (welcome/reader/TOC/settings) | `src/ui/` | S0, S2 |
| S7 Wire UI ↔ session + themes | `src/` | S5, S6 |
| S8 Playwright E2E + offline + privacy network | `e2e/` | S7 |
| S9 Pages headers, bundle budgets, release notes | `public/`, scripts | S7 |

**Lanes:**
- **Lane A:** S0 → S2 → S5 → S7  
- **Lane B:** S1 → S3 (after S0)  
- **Lane C:** S4 (after S0, parallel B)  
- **Lane D:** S6 (after S0, parallel B/C)  
- **Then:** S8 → S9  

**Execution:** After S0 lands on main, B + C + D can run in parallel worktrees. Merge before S5/S7 integration. Flag: S5 touches transform/convert APIs — merge B/C first.

**Conflict flags:** S5 and S7 both touch session wiring — sequential after libraries land.

---

## 9. TODOS.md proposals (not yet written — add if desired)

### T1 — Real-device iPhone Safari matrix
**What:** Manual checklist on physical iPhone (iOS 15+ if available) for offline, resume, images, conversion.  
**Why:** Plan correctly refuses to treat WebKit automation as device proof.  
**Priority:** P1 for release claim on iOS. **Effort:** M

### T2 — Bundle visual regression / theme screenshots
**What:** Playwright screenshots Ink & Jade vs Night Library.  
**Why:** Design is approved; prevents silent theme drift.  
**Priority:** P2. **Effort:** S

### T3 — EPUB.js fork evaluation log
**What:** If spike fails, record fork/foliate decision.  
**Priority:** P0 only if spike fails. **Effort:** M

---

## 10. Opinionated defaults (user asked for Codex handoff; no interactive picks)

| Topic | Default |
| --- | --- |
| Product scope | Full 0.1 as design written |
| Renderer | EPUB.js pinned; spike day 1 |
| Image gate | Pre-display hook only; hard fail tests if any image request early |
| Concurrency | Generation token on ReaderSession |
| Hash | Worker or async subtle crypto before blocking UI |
| UI binding | Event subscribe on ReaderSession |
| Sanitizer | Aggressive denylist + hostile fixtures |
| Conversion UX | Document Simplified→Traditional intent |
| Debounce | 300 ms progress; rAF resize |
| Telemetry | None in app (privacy); gstack anonymous only for tooling |

---

## Completion summary

| Item | Result |
| --- | --- |
| Step 0 Scope | Accepted full 0.1 (Codex handoff default) |
| Architecture | **8** issues (2 P0, 4 P1, 2 P2) |
| Code quality | **5** issues (1 P0, 3 P1, 1 P2) |
| Test review | Diagram produced; **all paths GAP** pre-code; required list above |
| Performance | **3** issues (1 P1, 2 P2) |
| NOT in scope | Written |
| What already exists | Written (nothing) |
| TODOS.md | 3 proposals (not auto-written) |
| Failure modes | **4 critical gaps** until MUST items land |
| Outside voice | Skipped (handoff mode) |
| Parallelization | 4 lanes after scaffold |
| Lake Score | 1/1 complete-scope recommendation held |

**Unresolved decisions left to human (non-blocking if defaults used):**
- Exact CSP final string after EPUB.js spike
- Max EPUB size messaging
- Whether landscape TOC is side panel or drawer-only on day one (default: follow design — drawer portrait, optional side landscape)

---

## Verdict

**Plan quality:** Strong product design, clear privacy story, good release gates.  
**Ship readiness of the plan itself:** Not yet — pin image hook, concurrency, sanitizer, and hash before implementation claims “design complete.”  
**Next for Codex:** Scaffold (S0) + fixture (S1) + transformer tests (S3) first; do not build chrome-only without security tests.
