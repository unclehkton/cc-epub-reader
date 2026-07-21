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
| `npm run test:e2e` | Playwright browser gates (when configured) |

## Cloudflare Pages

Static hosting only — **no** Pages Functions, Workers, Durable Objects, or other backend.

| Setting | Value |
| --- | --- |
| **Build command** | `npm run build` |
| **Build output directory** | `dist` |
| **Root directory** | repository root (default) |
| **Node version** | 20.19+ (match `package.json` `engines`) |

Deployed artifacts include:

- `dist/_headers` — `X-Content-Type-Options`, `Referrer-Policy`, and CSP
- `dist/_redirects` — SPA GET fallback to `/index.html` (`200`); share-target POST remains SW-only

Custom domain (e.g. `books.pkwor.com`) and DNS are external prerequisites. Attach HTTPS on Pages after the production build is verified locally.

## License

MIT — see [LICENSE](./LICENSE).
