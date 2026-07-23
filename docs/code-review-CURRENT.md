# Release 0.1 — current blockers (authoritative)

**Commit baseline for this table:** update after each full gate run (see Gates below).  
**History:** older narratives stay in archives; do not treat old “Fixed” rows as current without re-running commands.

## Verdict

Automated matrix on this worktree is the only green claim. **Physical iPhone Safari and live `books.pkwor.com` are not claimed.** Deploy only after those and a fresh independent re-review of the latest commit.

## Current residual risk (honest)

| ID | Residual | Status |
| --- | --- | --- |
| R1 | JSZip inflate worker may still allocate before consumer stream aborts | Accepted mitigation (consumer mid-stream abort + declared ceilings) |
| R2 | `createUrl` work cannot be cancelled inside epubjs; we dispose late blobs | Mitigated |
| R3 | Sanitizer is denylist + CSP, not full allowlist | **Accepted for 0.1** |
| R4 | epubjs 0.3.93 + `@xmldom/xmldom@0.9.10` override | **Accepted for 0.1** (audit 0) |
| R5 | Physical device / live domain | Open (deploy prerequisite) |
| R6 | Exact mid-chapter CFI on **mobile** long single-spine | **Accepted limit for 0.1** |
| R7 | Package CSS inject needs E2E visual proof + more package fixtures | Mitigated (inject path in; E2E visual CSS still open) |
| R8 | ZIP EOCD full hostile-fixture matrix incomplete | Mitigated (EOCD/ZIP64/entry/path guards; expand fixtures later) |
| R9 | Share-target policy profile staging incomplete | Open (G9) |
| R10 | Settings latest-wins via wrapper | **In** (`LatestWinsSettingsRepository`) |

## Hardening pass (feature/release-0.1)

| Area | Status |
| --- | --- |
| Operation settlement / same-spine next without full teardown | **In** |
| Resize without `display(cfi)` race; token cancel on beginOp | **In** |
| Converter original baseline preserved on rebind | **In** |
| ResumeTarget CFI → spineHref → first spine fallback | **In** |
| Platform import policy (Apple 25 warn / 50 block) | **In** |
| encryption.xml font obfuscation allow | **In** |
| IDB late-open close + onversionchange | **In** |
| SW update waits for controllerchange (+ timeout) | **In** |
| Package path resolution (section-relative) | **In** |
| Active-chapter CSS sanitize + inject | **In** |
| ValidatedImport.epubBytes single-read path | **In** |
| ZIP structure pre-check (EOCD/ZIP64/entries) | **In** |
| Settings latest-wins | **In** |
| Settings focus trap + Escape | **In** |
| Overlay poll only when overlays exist | **Partial** |
| GH Actions `release-0.1` workflow | **In** |
| Share-target staged policy confirm UX | **Open** |
| Full hostile ZIP fixture matrix / CSS E2E | **Open** |

## Gates (fresh — re-measure on each ship)

| Gate | Result |
| --- | --- |
| `npm run check` | pass |
| `npm run test:run` | **194** tests |
| `npm run build` / `check:bundle` | pass; shell **~71,724** gzip |
| `npm audit --audit-level=high` | **0 vulnerabilities** |
| `npm run test:e2e` | **44/44** (chromium, webkit, Mobile Chrome, Mobile Safari) |

## Physical-device validation

**Not performed in this environment.** Do not claim iPhone/iPad import limits without device logs.
