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
| R3 | Sanitizer is denylist + CSP, not full allowlist | **Accepted for 0.1** (allowlist deferred) |
| R4 | epubjs 0.3.93 + `@xmldom/xmldom@0.9.10` override | **Accepted for 0.1** (audit 0); engine major is 0.2+ work |
| R5 | Physical device / live domain | Open (deploy prerequisite) |
| R6 | Exact mid-chapter CFI on **mobile** long single-spine | **Accepted limit for 0.1**; E2E: exact CFI multi-chapter; spine+percent mobile long-spine. **Option C (epubjs 0.4) tried and rejected** — see below |

### R6 option C (epubjs 0.4) — tried, not merged

Branch `experiment/epubjs-0.4` / note `docs/experiments/epubjs-0.4-r6.md` (on that branch):

- **0.4.2 is not a drop-in:** `ePub()` is async; Book/Rendition/spine hooks model changed; would require rewriting reader-session + adapter + guards.
- **Package resolution broken** for modern ESM (`lib/index.js` extensionless imports fail).
- **Audit regression:** depends on deprecated `xmldom@0.1.x` (critical/moderate); our 0.3.93 + override stays at **0 vulns**.
- **No evidence** mid-chapter mobile CFI improves (could not complete a clean open/render smoke without a full rewrite).

**Decision:** stay on **0.3.93**. Future R6 work = Locations % resume (option A), not a blind 0.4 bump.

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
