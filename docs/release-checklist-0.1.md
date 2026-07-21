# Release 0.1 checklist

**Branch:** `feature/release-0.1`  
**Product URL (target):** `https://books.pkwor.com`  
**Status:** Local gates verified, but **release approval is blocked by the 2026-07-21 critical code review**. Not deployed.

## Local gates (required before handoff)

Run from a clean install on the feature worktree:

```bash
npm ci
npm run check
npm run test:run
npm run build
npm run check:bundle
npm run test:e2e
```

| Gate | Pass criteria |
| --- | --- |
| TypeScript | `npm run check` exit 0 |
| Unit/component/integration | All Vitest tests green |
| Production build | `dist/` emits app, SW, manifest, `_headers`, `_redirects` |
| Bundle budget | Initial shell (JS+CSS linked from `index.html`) ≤ **153600** bytes gzip |
| Playwright | Chromium + WebKit (+ mobile projects if configured) green |

### Fresh verification record (2026-07-21, UTC+8)

| Item | Result |
| --- | --- |
| Timestamp | 2026-07-21 evening local (UTC+8), after `npm ci` |
| `npm run check` | pass |
| `npm run test:run` | **16** files, **103** tests passed |
| `npm run build` | pass |
| Shell gzip | **55123** bytes (JS 51962 + CSS 3161); budget 153600 |
| Lazy OpenCC chunk | ~506739 bytes gzip (not in shell budget) |
| Lazy EPUB.js-related chunk | ~102481 bytes gzip (not in shell budget) |
| `npm run test:e2e` | **28** tests passed with exit 0 across `chromium`, `webkit`, `Mobile Chrome`, `Mobile Safari` (7 scenarios × 4 projects); 156.9 seconds |
| Offline | Chromium projects exercise online-first → offline reload/resume; WebKit may use Cache Storage precache evidence when offline navigation is flaky on Windows |
| Physical iPhone | **Not run** — WebKit automation is evidence, not device proof |

Playwright runner note: the Windows `webServer`-hook deadlock was removed. Global setup now starts Vite with a 30-second readiness deadline, preflights Chromium/WebKit, and global teardown releases the preview process. The fresh full matrix exited normally and port 4173 was released.

## Diff hygiene

Confirm before merge/publish:

- [ ] No `.env`, secrets, credentials, or user EPUB data tracked
- [ ] No `node_modules/`, `dist/`, Playwright profiles, or traces from successful runs
- [ ] Only repository-owned fixtures under `tests/fixtures/`

## Product smoke (manual, production preview)

```bash
npm run build
npm run preview -- --host 127.0.0.1 --port 4173 --strictPort
```

1. Online: open library, import `tests/fixtures/reader-fixture.epub` and `large-chapter.epub`.
2. Read, switch 分頁/捲動, convert 香港繁體, reveal one local image.
3. Reload; confirm both books and progress remain.
4. DevTools → Offline → reload; shell and retained books still load from SW + IndexedDB.
5. Network: no EPUB upload POSTs; no unexpected third-party hosts while reading.

## External prerequisites (blocked without credentials)

| Step | Owner | Notes |
| --- | --- | --- |
| Publish public GitHub repository | Human | Open-source license already MIT |
| Cloudflare Pages project | Human | Build `npm run build`, output `dist`, Node 20.19+ |
| Custom domain `books.pkwor.com` | Human | HTTPS, manifest scope, SW scope |
| Live privacy / offline check on domain | Human | After DNS + HTTPS |
| Physical iPhone Safari validation | Human | iOS 15+ if available |

## Codex independent review

- [x] Review full branch diff vs `main`
- [x] Re-run local gates
- [ ] Resolve all P1 findings in [`code-review-2026-07-21.md`](code-review-2026-07-21.md)
- [ ] Re-review sanitizer, memory model, persistence races, PWA icons, and session-only storage fallback

## Explicit non-claims

Do **not** claim Release 0.1 is approved, deployed, or live until external deploy + live checks complete and the reviewer signs off.
