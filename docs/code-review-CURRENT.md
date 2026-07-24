# Release 0.1 — current blockers (authoritative)

**Commit baseline for this table:** update after each full gate run (see Gates below).  
**History:** older narratives stay in archives; do not treat old “Fixed” rows as current without re-running commands.

## Verdict

Automated matrix on this worktree is the only green claim. **Physical iPhone Safari and live `books.pkwor.com` are not claimed.** Deploy only after those and a fresh independent re-review of the latest commit.

## Current residual risk (honest)

| ID | Residual | Status |
| --- | --- | --- |
| R1 | JSZip inflate worker may still allocate before consumer stream aborts | Accepted mitigation (declared size reject + stream abort + no createUrl for CSS) |
| R2 | `createUrl` work cannot be cancelled inside epubjs; we dispose late blobs | Mitigated (images only; CSS uses bounded archive reader) |
| R3 | Sanitizer is denylist + CSP, not full allowlist | **Accepted for 0.1** |
| R4 | epubjs 0.3.93 + `@xmldom/xmldom@0.9.10` override | **Accepted for 0.1** |
| R5 | Physical device / live domain | Open (deploy prerequisite) |
| R6 | Exact mid-chapter CFI on **mobile** long single-spine | **Accepted limit for 0.1** |
| R7 | Package CSS visual E2E | Open (bounded inject path in) |
| R8 | ZIP EOCD full hostile-fixture matrix incomplete | Mitigated (guards in; expand fixtures later) |
| R9 | Share-target accessible modal (uses `window.confirm`) | Open (P2) |
| R10 | Settings latest-wins via wrapper | **In** |

## Hardening (feature/release-0.1) — 0724-002

| Area | Status |
| --- | --- |
| Destination Document ready **before** commit/revoke old chapter | **In** |
| Settlement timeout: **verified rollback** (live Doc + matching spine location) | **In** |
| CSS via bounded archive stream (no createUrl; stream wall-clock timeout) | **In** |
| Share inbox returns ArrayBuffer only (no Blob wrapper) | **In** |
| encryption.xml DOMParser (comment decoy closed) | **In** |
| Share validateEpubBytes single-read | **In** |
| Nav serialization + same-spine keep bindings | **In** |
| Platform import policy (Apple 25/50) | **In** |

## Gates (fresh — re-measure on each ship)

| Gate | Result |
| --- | --- |
| `tsc -b` / check | pass |
| `vitest run` | **228** tests |
| `vite build` / `check:bundle` | pass; shell **~74,694** gzip |
| Playwright e2e | **44/44** (chromium, webkit, Mobile Chrome, Mobile Safari) |
| Physical iPhone / live domain | **Not a merge requirement** (per latest decision) |

## Physical-device validation

**Not performed in this environment.** Do not claim iPhone/iPad import limits without device logs.
