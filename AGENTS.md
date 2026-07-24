# Agent notes — books-pkwor EPUB reader

Instructions for coding agents working in this repository. Keep this file short and actionable.

## Cloudflare Pages deploy (do not repeat)

**Incident (2026-07-24):** Release `88d20c0` was deployed with `--branch=main`. Wrangler treated it as a **Preview** deployment. Custom domain **https://books.pkwor.com** tracks **Production**, which was still an older commit (`01d3a94` on `feature/release-0.1`). Users saw a build **without** OpenCC license UI, swipe/margins settings, simplified Chinese options, etc., even though those features existed in the approved SHA.

### Rules before claiming “deployed to production”

1. **Know the project’s Production branch**
   - Project name: `books-pkwor`
   - Production has historically been tied to **`feature/release-0.1`** (not necessarily `main`).
   - Confirm with:
     ```bash
     bunx wrangler pages deployment list --project-name=books-pkwor
     ```
   - Look at the **Environment** column: Production vs Preview, and **Branch**.

2. **Deploy to Production explicitly**
   - Use the **same branch name Cloudflare treats as Production**, e.g.:
     ```bash
     bunx wrangler pages deploy dist \
       --project-name=books-pkwor \
       --branch=feature/release-0.1 \
       --commit-hash=<exact-sha>
     ```
   - Do **not** assume `--branch=main` updates `books.pkwor.com`.

3. **Verify production by asset hash, not only “deploy success”**
   - After deploy, fetch live HTML and compare asset filenames to local `dist/`:
     ```text
     https://books.pkwor.com/          → production
     https://main.books-pkwor.pages.dev → often preview/alias only
     ```
   - Expected pattern: `index-*.js` / `index-*.css` hashes must match the build you just produced.
   - If production still serves a different `index-*.js` hash, Production was not updated.

4. **PWA / SW**
   - Even after a correct Production deploy, installed PWAs may keep an old shell until hard refresh / site data clear. Tell users that when debugging “I don’t see the new UI.”

### Quick checklist

- [ ] Built `dist` from the **exact approved SHA**
- [ ] `wrangler pages deployment list` shows new row under **Production** (not only Preview)
- [ ] `books.pkwor.com` view-source shows the **new** asset hashes
- [ ] Spot-check: library “開放原始碼授權”, settings 左右邊距 / 目錄位置 / 介面語言 / 簡體 conversion

## Product reminders (features that must stay shippable)

These were user requirements that shipped in release 0.1; regressions should be treated as bugs:

1. **OpenCC / third-party license notice** in the library UI  
2. **Mobile swipe** page turn, **horizontal margins**, avoid double-tap zoom where possible  
3. **Image gate** “點擊顯示圖片” must work (parent overlays on WebKit)  
4. **TOC side** left/right in settings; conversion applies to active chapter text  
5. **UI language** 繁/简 and conversion **繁→簡 (simplified)**  

## Repo layout

- Primary app work may live on `main` after merge of the approved release SHA.
- Cloudflare Pages project: **`books-pkwor`** → **https://books.pkwor.com**
