# Grok Build handoff: PWA EPUB Reader Tasks 3-12

Use this file as the task brief for Grok Build after commit `c038e14`.

## Fixed workspace and scope

- Repository: `D:\Projects\ebook`
- Isolated writable worktree: `D:\Projects\ebook\.worktrees\release-0.1`
- Branch: `feature/release-0.1`
- Required starting commit: `c038e14`
- Canonical detailed plan: `docs/superpowers/plans/2026-07-21-pwa-epub-reader-release-0.1.md`
- Approved design: `docs/superpowers/specs/2026-07-21-pwa-epub-reader-design.md`
- Engineering review: `docs/superpowers/specs/2026-07-21-pwa-epub-reader-eng-review.md`

Only read and modify files inside the isolated worktree. Do not inspect or send secrets, credentials, `.env` files, unrelated repositories, or unrelated user files. EPUB contents must remain local; do not add a backend, telemetry, analytics, or remote content processing.

Do not merge, push, deploy, attach the custom domain, or alter `main`. Codex will perform the final review after these tasks.

## Execution rules

1. Execute Tasks 3 through 12 strictly in order. Later tasks depend on earlier interfaces.
2. Before each task, read its complete section in the canonical detailed plan. This handoff is the execution index; the canonical section is authoritative for every interface, security rule, fixture, and acceptance detail.
3. Use test-driven development for production code:
   - add the focused test first;
   - run it and record the intended failure;
   - implement the smallest production change;
   - rerun the focused test and required verification.
4. Diagnose failures from evidence. Do not weaken security validation or tests merely to make a suite pass.
5. Keep commits task-scoped. Do not combine tasks or perform unrelated refactors.
6. Review `git diff --check`, the staged diff, and `git status --short` before every commit.
7. Update `implementation-notes.html` for meaningful decisions and verified behavior. Do not replace verified evidence with assumptions.
8. If `node` or `npm` is not on `PATH`, prepend:
   `C:\Users\Administrator\AppData\Local\OpenAI\Codex\runtimes\cua_node\03b1cdac8af3a530\bin`
9. Never commit `node_modules`, `dist`, `tsconfig.tsbuildinfo`, browser profiles, Playwright traces from successful runs, user EPUBs, secrets, or `.env` files.
10. If a requirement is blocked, stop that task, preserve the failing evidence, and describe the blocker. Do not skip ahead.

## Task 3: EPUB envelope validation and metadata extraction

Read the full canonical Task 3 section before editing.

- Create `src/library/epub-validator.ts`, `src/library/import-errors.ts`, `tests/helpers/make-epub.ts`.
- Test `tests/unit/epub-validator.test.ts` first.
- Cover EPUB extension/MIME acceptance, ZIP magic, container rootfile resolution, OPF title/creator, encryption rejection, and configurable size ceiling.
- Keep validation local, bounded to 100 MiB by default, destroy EPUB.js resources, return the original Blob, and avoid leaking file content in errors.
- Verify: `npm run test:run -- tests/unit/epub-validator.test.ts` and `npm run check`.
- Commit: `feat: validate local EPUB imports`.

## Task 4: Reading-list library interface

Read the full canonical Task 4 section before editing.

- Create `src/library/library-screen.tsx`, `src/library/book-row.tsx`, `src/library/delete-dialog.tsx`, `src/library/storage-notice.tsx`.
- Modify `src/app.tsx`, `src/app.css`.
- Test `tests/components/library-screen.test.tsx` first.
- Cover list rendering, local import, invalid-import preservation, opening, confirmed deletion, cancel-focus restoration, 44px controls, and accurate storage limitations.
- Verify: `npm run test:run -- tests/components/library-screen.test.tsx` and `npm run check`.
- Commit: `feat: add the local reading-list library`.

## Task 5: Pre-serialization sanitizer and image gates

Read the full canonical Task 5 section before editing. Treat it as security-critical.

- Create `src/reader/chapter-transformer.ts`, `src/reader/archive-url.ts`.
- Test `tests/unit/chapter-transformer.test.ts` and `tests/integration/image-isolation.test.ts` first with hostile documents.
- Sanitize before serialization, allow only resolver-approved archive-local URLs, make active content inert, replace images with accessible `點擊顯示圖片` gates, and dispose every listener/resource on chapter exit.
- Do not add a weaker post-render fallback sanitizer.
- Verify both focused suites and `npm run check`.
- Commit: `feat: isolate EPUB content and gate images`.

## Task 6: Chapter-local OpenCC conversion

Read the full canonical Task 6 section before editing.

- Create `src/reader/chapter-converter.ts`, `src/reader/opencc-profiles.ts`.
- Test `tests/unit/chapter-converter.test.ts` first.
- Support `original`, `traditional`, `hong-kong`, and `taiwan`; lazy-load `opencc-js`; convert only eligible visible text in the active chapter; preserve originals; reject stale generations; restore originals on errors.
- Verify: `npm run test:run -- tests/unit/chapter-converter.test.ts` and `npm run check`.
- Commit: `feat: convert only the active chapter locally`.

## Task 7: EPUB.js ReaderSession lifecycle

Read the full canonical Task 7 section before editing and implement its interfaces exactly.

- Create `src/reader/reader-session.ts`, `src/reader/epub-adapter.ts`.
- Test `tests/unit/reader-session.test.ts` and `tests/integration/epub-hook-order.test.ts` first.
- Enforce generation ownership after every await, single visible spine item, `allowScriptedContent: false`, sanitizer registration only through `book.spine.hooks.content`, and complete teardown/revocation.
- Verify both focused suites and `npm run check`.
- Commit: `feat: manage single-flight EPUB reader sessions`.

## Task 8: Progress, reading modes, and reader controls

Read the full canonical Task 8 section before editing.

- Create `src/reader/progress-tracker.ts`, `src/reader/reader-screen.tsx`, `src/reader/settings-sheet.tsx`, `src/reader/toc-drawer.tsx`, `src/settings/settings-repository.ts`.
- Modify `src/app.tsx`, `src/app.css`.
- Test `tests/unit/progress-tracker.test.ts` and `tests/components/reader-screen.test.tsx` first.
- Cover paginated/scrolled modes, progress persistence/recovery, TOC, appearance, four conversion labels, fullscreen/focus fallback, resize/orientation CFI restoration, and accessible error announcements.
- Use the approved Ink & Jade daytime design and Night Library night mode; keep control positions stable.
- Verify both focused suites and `npm run check`.
- Commit: `feat: add reading modes appearance and recovery`.

## Task 9: Offline PWA and local share target

Read the full canonical Task 9 section before editing.

- Create `src/sw.ts`, `src/sw/share-import.ts`, `src/vite-env.d.ts`, and the three required PWA icons.
- Modify `vite.config.ts`, `src/app.tsx`.
- Test `tests/unit/share-import.test.ts` and `tests/integration/service-worker-share.test.ts` first.
- Use `injectManifest`; accept exactly one local EPUB share, stage it in IndexedDB, redirect locally, atomically promote it in the app, expire inbox entries after 24 hours, and never forward the POST to a server/cache route.
- Verify focused suites and `npm run build`; inspect `dist/manifest.webmanifest` and `dist/sw.js` for the exact share target and absence of backend/user-data URLs.
- Commit: `feat: add offline PWA and local EPUB share target`.

## Task 10: Cloudflare Pages security and deployment files

Read the full canonical Task 10 section before editing.

- Create `public/_headers`, `public/_redirects`, `README.md`.
- Test `tests/unit/deployment-config.test.ts` first.
- Keep hosting static with no Pages Function or backend. Apply the narrow approved CSP and other headers. Add `blob:` only to the exact directive proven necessary by production preview, then document that evidence in `implementation-notes.html`.
- Ensure SPA GET fallback does not pretend `/share-target` is a server POST handler.
- Verify focused suite and `npm run build`.
- Commit: `docs: configure secure Cloudflare Pages hosting`.

## Task 11: Fixture EPUB and browser release gates

Read the full canonical Task 11 section before editing.

- Create both fixture EPUBs, Playwright configuration, five named E2E suites, and `scripts/check-bundle.mjs`; modify `package.json` and lockfile only as required.
- Add failing E2E expectations before closing integration gaps.
- Cover two retained books, distinct resume positions, both flows, Hong Kong conversion, gated local image lifecycle, deletion, portrait/landscape, offline reload, hostile/remote-content isolation, and zero EPUB uploads.
- Enforce an initial-shell gzip budget of 153600 bytes; report lazy EPUB.js/OpenCC chunks separately.
- Run: `npm run check && npm run test:run && npm run build && npm run check:bundle && npm run test:e2e`.
- Commit: `test: cover offline mobile EPUB reading`.

## Task 12: Fresh release evidence and handoff

Read the full canonical Task 12 section before editing.

- Modify `implementation-notes.html`, `README.md`; create `docs/release-checklist-0.1.md`.
- Review the full branch diff and tracked-file list for secrets, user data, generated profiles, and unrelated paths.
- Run fresh: `npm ci && npm run check && npm run test:run && npm run build && npm run check:bundle && npm run test:e2e`.
- Exercise online-first then offline reload/resume through production preview. Record exact test counts, bundle sizes, browser projects, UTC+8 timestamp, and any physical-iPhone limitation.
- Document local development, privacy, supported platforms, Cloudflare Pages build/output settings, CSP rationale, storage behavior, and external prerequisites.
- Commit: `docs: record release 0.1 verification`.
- The canonical plan's phrase “clean main worktree” is overridden here: the required result is a clean `feature/release-0.1` isolated worktree. Do not check out or modify `main`.

## Required final response to Codex

After Task 12, stop and report:

- starting and ending commit hashes;
- one commit hash per Task 3-12;
- exact RED evidence and GREEN verification commands per task;
- complete final test counts, browser projects, and bundle sizes;
- production-preview offline/privacy evidence;
- any skipped, flaky, or device-only checks;
- `git status --short --branch` output;
- all remaining risks or external prerequisites.

Do not state that Release 0.1 is approved, deployed, or live. Codex will independently review the entire diff and rerun the final gates.
