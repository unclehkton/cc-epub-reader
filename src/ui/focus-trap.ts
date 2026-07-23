/**
 * Minimal focus trap for modal dialogs (settings, delete, license, import warn).
 */

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function getFocusable(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => !el.hasAttribute("disabled") && el.offsetParent !== null,
  );
}

export interface FocusTrapHandle {
  release(): void;
}

/**
 * Trap Tab focus inside `container`, focus initial element (or first focusable),
 * restore focus to `restore` on release.
 */
export function installFocusTrap(
  container: HTMLElement,
  options: {
    initialFocus?: HTMLElement | null;
    restoreFocus?: HTMLElement | null;
  } = {},
): FocusTrapHandle {
  const previouslyFocused =
    options.restoreFocus ??
    (document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null);

  const focusInitial = () => {
    const target =
      options.initialFocus ?? getFocusable(container)[0] ?? container;
    try {
      target.focus();
    } catch {
      // ignore
    }
  };

  // Defer to next frame so dialog is in the tree.
  requestAnimationFrame(focusInitial);

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Tab") return;
    const list = getFocusable(container);
    if (list.length === 0) {
      event.preventDefault();
      return;
    }
    const first = list[0]!;
    const last = list[list.length - 1]!;
    const active = document.activeElement;
    if (event.shiftKey) {
      if (active === first || !container.contains(active)) {
        event.preventDefault();
        last.focus();
      }
    } else if (active === last) {
      event.preventDefault();
      first.focus();
    }
  };

  container.addEventListener("keydown", onKeyDown);

  return {
    release() {
      container.removeEventListener("keydown", onKeyDown);
      if (previouslyFocused) {
        try {
          previouslyFocused.focus();
        } catch {
          // ignore
        }
      }
    },
  };
}
