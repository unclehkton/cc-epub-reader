# PWA Install Prompt Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a non-blocking, bottom-of-library PWA-install guide for uninstalled iPhone and Android browser users.

**Architecture:** Keep browser and PWA-display detection in a pure platform module, so it is testable without rendering. An app-shell hook captures Chrome's optional `beforeinstallprompt` event and exposes a small view model to a presentational library card; the card receives no browser globals and only renders enabled platform-specific content.

**Tech Stack:** Preact, TypeScript, Vitest with Testing Library, Playwright, CSS, Vite PWA.

## Global Constraints

- Show the card only for iPhone (`iphone` or `ipod` user agents) and Android (`android` user agents).
- Never show it when `display-mode: standalone`, `display-mode: fullscreen`, or iOS `navigator.standalone` indicates an installed PWA.
- Use Traditional Chinese (Hong Kong) copy and match existing paper / jade library styling.
- iPhone gives Safari Share → `加入主畫面` instructions; Android opens the native install prompt only when `beforeinstallprompt` is available and otherwise gives Chrome menu instructions.
- The card must not use an overlay, block library controls, make external requests, or persist user data; closing it hides it only for the current page session.
- Preserve the unrelated untracked `bugs/` directory.

---

## File structure

| File | Responsibility |
| --- | --- |
| `src/platform/pwa-install.ts` | Pure platform and installed-display-mode classification, plus the typed deferred-install-event contract. |
| `src/platform/use-pwa-install-prompt.ts` | Browser event lifecycle and session-only dismissal state exposed to the app shell. |
| `src/library/pwa-install-prompt.tsx` | Accessible, platform-specific card rendered without direct browser API access. |
| `src/app.tsx` | Creates the hook state and passes it to the library screen. |
| `src/library/library-screen.tsx` | Reserves the integrated library-bottom placement for the card. |
| `src/app.css` | Card, icon, action, close control, and small-phone layout styling. |
| `tests/unit/pwa-install.test.ts` | Pure platform / installed-mode red-green regressions. |
| `tests/components/pwa-install-prompt.test.tsx` | Copy, action, and dismissal behavior using the card's public props. |
| `tests/e2e/mobile.spec.ts` | Real mobile viewport visibility and installed-display-mode absence coverage. |
| `implementation-notes.html` | Records the behavior, browser limitations, and fresh verification evidence. |

## Interfaces

```ts
export type PwaInstallPlatform = "iphone" | "android" | null;

export interface DeferredInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

export interface PwaInstallPromptModel {
  platform: PwaInstallPlatform;
  visible: boolean;
  canPromptInstall: boolean;
  dismiss(): void;
  promptInstall(): Promise<void>;
}

export function getPwaInstallPlatform(input: {
  userAgent: string;
  standalone: boolean;
  displayModeStandalone: boolean;
  displayModeFullscreen: boolean;
}): PwaInstallPlatform;
```

### Task 1: Classify eligible mobile browsers without browser side effects

**Files:**
- Create: `src/platform/pwa-install.ts`
- Test: `tests/unit/pwa-install.test.ts`

**Consumes:** Browser-derived strings and booleans only.

**Produces:** `PwaInstallPlatform`, `DeferredInstallPromptEvent`, and `getPwaInstallPlatform(input)` for the hook.

- [ ] **Step 1: Write failing pure classification tests**

```ts
it("returns iphone only when Safari is not already installed", () => {
  expect(getPwaInstallPlatform({
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)",
    standalone: false,
    displayModeStandalone: false,
    displayModeFullscreen: false,
  })).toBe("iphone");
});

it.each([
  { userAgent: "Mozilla/5.0 (Linux; Android 15)", standalone: false, displayModeStandalone: false, displayModeFullscreen: false },
  { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)", standalone: true, displayModeStandalone: false, displayModeFullscreen: false },
  { userAgent: "Mozilla/5.0 (Linux; Android 15)", standalone: false, displayModeStandalone: true, displayModeFullscreen: false },
  { userAgent: "Mozilla/5.0 (Windows NT 10.0)", standalone: false, displayModeStandalone: false, displayModeFullscreen: false },
])("returns null for non-eligible state %#", (input) => {
  expect(getPwaInstallPlatform(input)).toBeNull();
});
```

- [ ] **Step 2: Run the new test to verify RED**

Run: `npm run test:run -- tests/unit/pwa-install.test.ts`

Expected: FAIL because `src/platform/pwa-install.ts` and `getPwaInstallPlatform` do not exist.

- [ ] **Step 3: Implement the smallest classifier**

```ts
export function getPwaInstallPlatform(input: PwaInstallEnvironment): PwaInstallPlatform {
  if (input.standalone || input.displayModeStandalone || input.displayModeFullscreen) {
    return null;
  }
  if (/iphone|ipod/i.test(input.userAgent)) return "iphone";
  if (/android/i.test(input.userAgent)) return "android";
  return null;
}
```

Define `PwaInstallEnvironment` with the four exact input fields and export the
`DeferredInstallPromptEvent` interface from the same module. Do not read
`window` or `navigator` in this file.

- [ ] **Step 4: Run the classifier test to verify GREEN**

Run: `npm run test:run -- tests/unit/pwa-install.test.ts`

Expected: PASS with all listed iPhone, Android, installed, and desktop cases.

- [ ] **Step 5: Commit the independently tested platform boundary**

```powershell
& 'C:\Program Files\Git\cmd\git.exe' add -- src/platform/pwa-install.ts tests/unit/pwa-install.test.ts
& 'C:\Program Files\Git\cmd\git.exe' commit -m "feat: classify eligible PWA install browsers"
```

### Task 2: Capture the optional Android install event in the app shell

**Files:**
- Create: `src/platform/use-pwa-install-prompt.ts`
- Modify: `src/app.tsx:395-704`
- Test: `tests/components/app-shell.test.tsx`

**Consumes:** `getPwaInstallPlatform`, `DeferredInstallPromptEvent`, and the browser's `beforeinstallprompt` event.

**Produces:** `usePwaInstallPrompt(): PwaInstallPromptModel`; `App` passes its model to `LibraryScreen`.

- [ ] **Step 1: Write failing app-shell tests for the event lifecycle**

```tsx
it("offers Android native installation and hides after the choice", async () => {
  Object.defineProperty(navigator, "userAgent", { configurable: true, value: "Mozilla/5.0 (Linux; Android 15)" });
  const prompt = vi.fn().mockResolvedValue(undefined);
  const event = new Event("beforeinstallprompt") as DeferredInstallPromptEvent;
  Object.assign(event, { prompt, userChoice: Promise.resolve({ outcome: "dismissed" }) });
  render(<App />);
  window.dispatchEvent(event);
  await userEvent.setup().click(await screen.findByRole("button", { name: "立即安裝" }));
  expect(prompt).toHaveBeenCalledOnce();
  expect(screen.queryByText("將書庫加入主畫面")).toBeNull();
});
```

Add a companion assertion that iPhone gets the Share / `加入主畫面` instruction,
and a standalone match-media setup renders neither card nor install action.

- [ ] **Step 2: Run the focused shell test to verify RED**

Run: `npm run test:run -- tests/components/app-shell.test.tsx`

Expected: FAIL because no install event is retained and no mobile install model reaches the library.

- [ ] **Step 3: Implement a guarded hook and wire it into `App`**

```ts
useEffect(() => {
  const onBeforeInstallPrompt = (event: Event) => {
    event.preventDefault();
    setDeferredEvent(event as DeferredInstallPromptEvent);
  };
  window.addEventListener("beforeinstallprompt", onBeforeInstallPrompt);
  return () => window.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt);
}, []);
```

Use `window.matchMedia` only behind an existence check. Initialise the model
from `navigator.userAgent`, `(display-mode: standalone)`, `(display-mode:
fullscreen)`, and `Boolean((navigator as Navigator & { standalone?: boolean }).standalone)`.
`promptInstall()` must no-op when no deferred event exists; otherwise await
`event.prompt()` then `event.userChoice`, clear the event, and set the
session-only dismissed state. Pass the model as `pwaInstallPrompt` to
`LibraryScreen`.

- [ ] **Step 4: Run the focused shell test to verify GREEN**

Run: `npm run test:run -- tests/components/app-shell.test.tsx`

Expected: PASS; the Android event has `preventDefault()` called, `prompt()` is
called once after the user action, and standalone is hidden.

- [ ] **Step 5: Commit the hook and app integration**

```powershell
& 'C:\Program Files\Git\cmd\git.exe' add -- src/platform/use-pwa-install-prompt.ts src/app.tsx tests/components/app-shell.test.tsx
& 'C:\Program Files\Git\cmd\git.exe' commit -m "feat: retain native PWA install prompt"
```

### Task 3: Render the integrated library-bottom card and its mobile styling

**Files:**
- Create: `src/library/pwa-install-prompt.tsx`
- Modify: `src/library/library-screen.tsx:31-39,282-295`
- Modify: `src/app.css:804-827`
- Test: `tests/components/pwa-install-prompt.test.tsx`

**Consumes:** `PwaInstallPromptModel` from the app hook.

**Produces:** `PwaInstallPrompt` rendered immediately above `library-footer`, with card controls that only call the model callbacks.

- [ ] **Step 1: Write failing presentational-card tests**

```tsx
it("shows the iPhone Safari share instruction", () => {
  render(<PwaInstallPrompt model={iphoneModel} />);
  expect(screen.getByRole("heading", { name: "將書庫加入主畫面" })).toBeTruthy();
  expect(screen.getByText(/分享按鈕/)).toBeTruthy();
  expect(screen.getByText("加入主畫面")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "立即安裝" })).toBeNull();
});

it("uses Android fallback copy when native installation is unavailable", () => {
  render(<PwaInstallPrompt model={{ ...androidModel, canPromptInstall: false }} />);
  expect(screen.getByText(/Chrome.*選單/)).toBeTruthy();
});
```

Add tests that `立即安裝` calls `model.promptInstall`, the close button calls
`model.dismiss`, and `visible: false` renders nothing.

- [ ] **Step 2: Run the card tests to verify RED**

Run: `npm run test:run -- tests/components/pwa-install-prompt.test.tsx`

Expected: FAIL because `PwaInstallPrompt` does not exist.

- [ ] **Step 3: Implement accessible markup and scoped styling**

```tsx
return (
  <aside class="pwa-install-prompt" aria-labelledby="pwa-install-title">
    <button type="button" class="pwa-install-prompt__close touch-target" aria-label="關閉安裝提示" onClick={model.dismiss}>×</button>
    <div class="pwa-install-prompt__copy">
      <h2 id="pwa-install-title">將書庫加入主畫面</h2>
      {/* iPhone share instruction, Android fallback, or Android action */}
    </div>
  </aside>
);
```

Add only `.pwa-install-prompt*` CSS: paper surface, jade border/accent, rounded
corners, 44px action and close targets, visual share symbol, and
`env(safe-area-inset-bottom)` breathing room. Keep it in normal document flow
above the licence footer; do not use `position: fixed`, backdrop, or z-index.

- [ ] **Step 4: Run the card tests to verify GREEN**

Run: `npm run test:run -- tests/components/pwa-install-prompt.test.tsx`

Expected: PASS for iPhone, Android native action, Android fallback, hidden
state, and close action.

- [ ] **Step 5: Commit the visual component**

```powershell
& 'C:\Program Files\Git\cmd\git.exe' add -- src/library/pwa-install-prompt.tsx src/library/library-screen.tsx src/app.css tests/components/pwa-install-prompt.test.tsx
& 'C:\Program Files\Git\cmd\git.exe' commit -m "feat: add mobile PWA install guidance"
```

### Task 4: Verify real mobile layout and update the handoff record

**Files:**
- Modify: `tests/e2e/mobile.spec.ts`
- Modify: `implementation-notes.html`

**Consumes:** Complete responsive library prompt implementation.

**Produces:** Browser-level regression coverage and durable project documentation.

- [ ] **Step 1: Write failing mobile browser tests**

```ts
test("shows the iPhone home-screen guide without blocking the import control", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await gotoLibrary(page);
  await expect(page.getByRole("heading", { name: "將書庫加入主畫面" })).toBeVisible();
  await expect(page.getByRole("button", { name: "匯入 EPUB" })).toBeVisible();
  await expect(page.getByRole("button", { name: "關閉安裝提示" })).toBeVisible();
});
```

Use `page.addInitScript` before navigation to override `matchMedia` for
`(display-mode: standalone)`, then assert the heading is absent. Scope the two
tests to `Mobile Safari` / `Mobile Chrome`, checking the appropriate platform
copy from each browser's actual user agent.

- [ ] **Step 2: Run the focused browser tests to verify RED**

Run: `npx playwright test tests/e2e/mobile.spec.ts --project="Mobile Safari" --project="Mobile Chrome"`

Expected: FAIL before the card is implemented because its heading is absent.

- [ ] **Step 3: Run the focused browser tests to verify GREEN**

Run: `npx playwright test tests/e2e/mobile.spec.ts --project="Mobile Safari" --project="Mobile Chrome"`

Expected: PASS; the normal mobile library exposes the matching guide and the
simulated installed display mode exposes none.

- [ ] **Step 4: Record the implementation and verification evidence**

Add a dated `2026-07-31 PWA 安裝提示` section to `implementation-notes.html`.
State the iPhone and Android flows, the installed-PWA hide conditions, that
the card is normal-flow rather than blocking, and the exact commands/results
from Step 5. Do not claim iOS can programmatically open its install UI.

- [ ] **Step 5: Run the full release-relevant verification set**

Run:

```powershell
npm run test:run
npm run check
npm run build
npm run check:bundle
npx playwright test tests/e2e/mobile.spec.ts --project="Mobile Safari" --project="Mobile Chrome"
```

Expected: every command exits 0; report the Vitest assertion count, bundle
size, and Playwright pass count from the fresh output.

- [ ] **Step 6: Inspect the focused diff and commit documentation/tests**

```powershell
& 'C:\Program Files\Git\cmd\git.exe' diff --check
& 'C:\Program Files\Git\cmd\git.exe' status --short
& 'C:\Program Files\Git\cmd\git.exe' add -- tests/e2e/mobile.spec.ts implementation-notes.html
& 'C:\Program Files\Git\cmd\git.exe' commit -m "test: cover mobile PWA install prompt"
```

## Plan self-review

- **Spec coverage:** Tasks 1–2 cover UA and installed-PWA detection plus the optional Android native event. Task 3 covers both platform copies, accessible controls, integrated normal-flow appearance, and no external storage. Task 4 covers real mobile viewport and standalone absence, documentation, and release gates.
- **Placeholder scan:** The plan contains no deferred work markers; every test and implementation step names an exact file, interface, command, and expected outcome.
- **Type consistency:** `PwaInstallPlatform`, `DeferredInstallPromptEvent`, and `PwaInstallPromptModel` are defined once above and consumed by the hook and card using the same names.
