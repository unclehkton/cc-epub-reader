# Books — privacy-first PWA EPUB reader

Local-only EPUB library and reader. Imported books, metadata, settings, and reading progress stay in the browser (IndexedDB). There is no application backend, analytics endpoint, or remote book storage.

## Privacy

- EPUB bytes never leave the device for import, share-target staging, or reading.
- No analytics, tracking pixels, or third-party connect-src hosts.
- Share-target `POST /share-target` is intercepted by the service worker and written to a short-lived IndexedDB inbox; it is not a server upload.
- Security headers (including a narrow Content-Security-Policy) ship via Cloudflare Pages `public/_headers`.

## Supported platforms

- **Minimum:** Safari / iOS 15+ class WebKit (ES2019 build target).
- **Installed PWA:** Chromium-based browsers where Web Share Target is available (progressive enhancement).
- **Baseline import:** in-app file picker (works where share-target does not, including typical iPhone home-screen use).
- **Flows:** paginated and scrolled reading via pinned EPUB.js; Traditional Chinese (Hong Kong) UI copy.

## Local development

Requirements: **Node.js ≥ 20.19**.

```bash
npm ci
npm run dev
```

Other scripts:

| Command | Purpose |
| --- | --- |
| `npm run check` | TypeScript project build check (`tsc -b`) |
| `npm run test` / `npm run test:run` | Vitest (watch / single run) |
| `npm run build` | Production build into `dist/` |
| `npm run preview` | Serve the production build locally |
| `npm run check:bundle` | Fail if initial shell JS+CSS gzip &gt; 150 KiB |
| `npm run test:e2e` | Playwright (chromium, webkit, mobile projects) |
| `npm run fixtures` | Regenerate repository-owned test EPUBs |

### Release gates (local)

```bash
npm ci
npm run check
npm run test:run
npm run build
npm run check:bundle
npm run test:e2e
```

See [docs/release-checklist-0.1.md](./docs/release-checklist-0.1.md) for the recorded 0.1 verification evidence and external deploy prerequisites.

**Fast E2E while developing:** build once, then `npx playwright test --project=chromium`. Full matrix before handoff.

### Storage behavior

- Books, progress, settings, and share-inbox blobs live in IndexedDB database `books-reader`.
- EPUB payloads are stored as `ArrayBuffer` for WebKit compatibility.
- Browser site-data clear removes the library; the UI states storage is not a guaranteed backup folder.

## Cloudflare Pages

Static hosting only — **no** Pages Functions, Workers, Durable Objects, or other backend.

| Setting | Value |
| --- | --- |
| **Project** | `books-pkwor` |
| **Production URL** | https://books.pkwor.com |
| **Build command** | `npm run build` |
| **Build output directory** | `dist` |
| **Root directory** | repository root (default) |
| **Node version** | 20.19+ (match `package.json` `engines`) |

Deployed artifacts include:

- `dist/_headers` — `X-Content-Type-Options`, `Referrer-Policy`, and CSP
- `dist/_redirects` — SPA GET fallback to `/index.html` (`200`); share-target POST remains SW-only

### Deploy gotcha (agents)

**Production ≠ any successful `wrangler pages deploy`.**  
This project’s Production branch has been `feature/release-0.1`. Deploying with `--branch=main` can create a **Preview** only; `books.pkwor.com` keeps serving the last **Production** deployment.

Always:

1. `wrangler pages deployment list --project-name=books-pkwor` (Environment = Production)
2. Confirm `https://books.pkwor.com` HTML references the same `assets/index-*.js` hash as local `dist/`

See [AGENTS.md](./AGENTS.md) for the full checklist.

## License

MIT — see [LICENSE](./LICENSE).
