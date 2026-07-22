# Experiment: epubjs 0.4 for R6 (mobile mid-chapter CFI)

**Branch:** `experiment/epubjs-0.4`  
**Date:** 2026-07-22  
**Goal:** Option C for residual R6 — upgrade engine to improve exact CFI restore on mobile long single-spine books.  
**Result:** **Do not merge.** Keep **epubjs@0.3.93** + `@xmldom/xmldom@0.9.10` override.

## What was tried

```bash
npm install epubjs@0.4.2 --save-exact
```

## Findings (blocking)

### 1. Package is broken for ESM / Node resolution

- `package.json` points `main` → `lib/index.js`, `module` → `src/index.js`.
- Imports use extensionless paths (`./book/book`) that fail under modern Node ESM:
  - `ERR_MODULE_NOT_FOUND: .../epubjs/lib/book/book`
- Vite would need a forced alias to `dist/epub.js` just to load the package.

### 2. API is a rewrite, not a drop-in

0.4 `ePub(url, options)` is **async** and returns `Promise<Book>` after `Epub.open()`, not a synchronous Book with `.ready`.

Significant surface changes vs our adapter/session:

| 0.3.93 (current) | 0.4.2 |
| --- | --- |
| `ePub(buffer)` → Book with `book.ready` | `await ePub(buffer)` → Book after open |
| `book.spine.hooks.content` | Manifest/sections model; hooks layout differs |
| `book.renderTo(el, opts)` on Book | Sugar attaches different `Rendition(book.manifest, …)` |
| Local ArrayBuffer open well-trodden | `open()` path sensitive to type detection; binary open failed in Node smoke (`Url` / `indexOf`) without browser `window.location` |

Adopting 0.4 means re-implementing **ReaderSession + epub-adapter + replacements guard + image materialize + parent gates**, then full E2E — not a version bump.

### 3. Security regression on paper

0.4.2 depends on deprecated **`xmldom@0.1.x`** (critical/moderate advisories).  
`npm audit` reported **2** issues (1 moderate, 1 critical).  
Our 0.3.93 path uses **`@xmldom/xmldom@0.9.10` override → audit 0**.

Forcing a patched `xmldom` override under 0.4 is unproven and still leaves the API rewrite cost.

### 4. R6 unproven

No successful open/render of local fixtures in this experiment → **no evidence** that 0.4 fixes mobile mid-chapter CFI. Even if it did, cost/risk dominate.

## Decision

| Residual | Decision |
| --- | --- |
| R6 | Keep 0.3.93 mitigations: exact CFI for multi-chapter; spine + percent for long mobile single-spine; optional future **Locations %** (option A), not 0.4 |
| R3 | **Accepted** for 0.1 (denylist + CSP + no scripts) |
| R4 | **Accepted** for 0.1 (pin 0.3.93 + xmldom override); revisit engine only as a dedicated 0.2 project |

## Restore

Experiment branch tip restored to **epubjs@0.3.93** with clean audit.  
`feature/release-0.1` should remain the deploy line; **do not merge** engine upgrade from this experiment.
