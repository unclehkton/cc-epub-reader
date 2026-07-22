# Release 0.1 — current blockers (authoritative)

**Commit baseline for this table:** update when re-running gates.  
**History / narrative of earlier reviews:** [`code-review-2026-07-21.md`](code-review-2026-07-21.md) (archive only; do not treat old “Fixed” rows as current).

## Verdict

Automated matrix on this worktree is the only green claim. **Physical iPhone Safari and live `books.pkwor.com` are not claimed.** Deploy only after those and a fresh independent re-review.

## Current residual risk (honest)

| ID | Residual | Status |
| --- | --- | --- |
| R1 | JSZip inflate worker may still allocate before consumer stream aborts | Accepted mitigation (consumer mid-stream abort + declared ceilings) |
| R2 | `createUrl` work cannot be cancelled inside epubjs; we dispose late blobs | Mitigated |
| R3 | Sanitizer is denylist + CSP, not full allowlist | Open by design for 0.1 |
| R4 | epubjs 0.3.93 API + xmldom override (not 0.4 major) | Open |
| R5 | Physical device / live domain | Open |
| R6 | Exact mid-chapter CFI restore on **mobile** long single-spine chapters is unreliable in epubjs 0.3.93; E2E asserts spine + progress **percent** (±5) there, and **exact CFI** for multi-chapter TOC resume | Documented product/engine limit |

## Closed in latest pass (must have tests)

| ID | Finding | Evidence |
| --- | --- | --- |
| C1 | Exact multi-book CFI resume across reload | E2E captures CFI before close; asserts equality after reopen |
| C2 | Late/unowned blob + oversize cache | Unit: late revoke; fail-closed size-check; oversize purge |
| C3 | External links parent open | E2E stubs `window.open`; requires noopener + example.com |
| C4 | Image reveal decode | E2E requires `naturalWidth > 0` on blob/data src |
| C5 | Durable library after hard reload + re-nav | E2E multi-book stress |
| C6 | Docs single source of truth | This file + rewritten `implementation-notes.html` |

## Gates (measured after residual-list pass)

| Gate | Result |
| --- | --- |
| `npm run check` | pass |
| `npm run test:run` | **119** tests |
| `npm run build` / `check:bundle` | pass; shell **61,123** gzip |
| `npm audit` | **0** (xmldom override) |
| `npm run test:e2e` | **40/40** (~3.7 min; all 4 projects) |
