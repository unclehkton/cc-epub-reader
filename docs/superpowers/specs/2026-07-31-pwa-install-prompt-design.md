# PWA install prompt design

## Goal

Encourage people using the Books EPUB reader in a mobile browser to add it to
their home screen, without interrupting importing or reading. The prompt must
be hidden whenever the app is already installed as a PWA.

## Scope

- Render one bottom-of-library prompt only for iPhone and Android browsers.
- Hide it in standalone or fullscreen PWA display mode, including iOS Safari's
  `navigator.standalone` signal.
- Use platform-specific, Traditional Chinese (Hong Kong) instructions.
- On Android, use the browser's `beforeinstallprompt` event when available so
  the primary action can open the native install prompt.
- Provide a close control that hides the prompt for the current browser
  session. A fresh visit can invite an uninstalled user again.
- Do not show a desktop, iPad, unknown-platform, or already-installed prompt.

## Interface

The component is integrated below the library's primary content rather than
using a modal or page-wide overlay. It uses the reader's existing paper-toned
surface, dark-green accent, rounded corners, and system typography.

| Platform | Content | Primary action |
| --- | --- | --- |
| iPhone Safari | Title: `將書庫加入主畫面`; visual Safari share icon; instruction to tap Share, then `加入主畫面`. | Informational; no synthetic install action is possible in Safari. |
| Android | Title: `將書庫加入主畫面`; short benefit statement. | `立即安裝` when a deferred native install prompt exists; otherwise show Chrome menu instructions. |

The component has an accessible close button labelled `關閉安裝提示`. It must
not block the `匯入 EPUB` button, library controls, or reader interactions.

## Platform decision flow

1. At render time, derive the operating system from the browser user agent:
   `iphone` / `ipod` are iPhone; `android` is Android. iPads and unknown user
   agents remain out of scope and return no prompt.
2. Before selecting content, detect installed display state with
   `matchMedia('(display-mode: standalone)')`, `matchMedia('(display-mode: fullscreen)')`,
   and iOS `navigator.standalone`. If any is true, return no prompt.
3. Register `beforeinstallprompt` in the app shell. Prevent its automatic
   browser UI, retain the event for the Android prompt, and clear it after the
   user chooses an outcome.
4. The Android action calls the retained event's `prompt()` and awaits
   `userChoice`; the card then hides for the session. If the event is absent,
   show the non-actionable Android instruction instead.
5. The iPhone card only offers the instruction and close action because
   mobile Safari exposes no equivalent programmable install prompt.

## Boundaries and error handling

- Browser-only APIs are guarded for test and server safety.
- The deferred install event is treated as optional. Its absence changes only
  the wording, never blocks the library.
- Dismissing, declining, or accepting installation hides the card until the
  next browser session; installed display mode always wins over this state.
- No analytics, external requests, or user data persistence are introduced.

## Test plan

1. Unit-test platform and installed-state classification with iPhone, Android,
   desktop, standalone, fullscreen, and iOS standalone inputs.
2. Component-test iPhone copy, Android fallback copy, close action, and the
   Android install action using a real event-shaped test double.
3. Extend mobile Playwright coverage to assert that the prompt is visible at
   the bottom of an uninstalled mobile library viewport and absent when the
   standalone display mode is simulated.
4. Run Vitest, TypeScript checking, production build, bundle check, and the
   relevant mobile browser tests before completion.

## Non-goals

- No native iOS wrapper, Share Extension, app-store distribution, or iPad
  onboarding.
- No install prompt on desktop or manual install instruction for every browser.
- No modal, forced installation, or persistent tracking of users.
