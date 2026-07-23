import type { TocSide, UiLanguage } from "../domain/types";
import { t } from "../ui/strings";

export interface TocEntry {
  label: string;
  href: string;
}

export interface TocDrawerProps {
  open: boolean;
  entries: TocEntry[];
  activeHref?: string;
  /** When true, render as a persistent side panel (wide landscape). */
  sidePanel?: boolean;
  /** Overlay / side panel dock side. */
  side?: TocSide;
  uiLanguage?: UiLanguage;
  onSelect: (href: string) => void;
  onClose: () => void;
}

export function TocDrawer({
  open,
  entries,
  activeHref,
  sidePanel = false,
  side = "left",
  uiLanguage = "zh-Hant",
  onSelect,
  onClose,
}: TocDrawerProps) {
  if (!open && !sidePanel) {
    return null;
  }

  const visible = sidePanel || open;
  const className = [
    "toc-drawer",
    sidePanel ? "toc-drawer--side" : "toc-drawer--overlay",
    side === "right" ? "toc-drawer--right" : "toc-drawer--left",
    visible ? "toc-drawer--open" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <>
      {!sidePanel && open ? (
        <button
          type="button"
          class="toc-backdrop"
          aria-label={t(uiLanguage, "close")}
          onClick={onClose}
        />
      ) : null}
      <nav
        class={className}
        aria-label={t(uiLanguage, "toc")}
        hidden={sidePanel ? false : !open}
      >
        <div class="toc-drawer-header">
          <h2 class="toc-drawer-title">{t(uiLanguage, "toc")}</h2>
          {!sidePanel ? (
            <button
              type="button"
              class="toc-close touch-target"
              style={{ minWidth: "44px", minHeight: "44px" }}
              aria-label={t(uiLanguage, "close")}
              onClick={onClose}
            >
              {t(uiLanguage, "close")}
            </button>
          ) : null}
        </div>
        <ul class="toc-list">
          {entries.map((entry) => {
            const active =
              activeHref !== undefined &&
              (entry.href === activeHref ||
                activeHref.endsWith(entry.href) ||
                entry.href.endsWith(activeHref));
            return (
              <li key={entry.href}>
                <button
                  type="button"
                  class={[
                    "toc-item touch-target",
                    active ? "toc-item--active" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  style={{ minWidth: "44px", minHeight: "44px" }}
                  aria-current={active ? "location" : undefined}
                  onClick={() => {
                    onSelect(entry.href);
                    // Always request close after select; parent no-ops for side panel.
                    onClose();
                  }}
                >
                  {entry.label}
                </button>
              </li>
            );
          })}
        </ul>
      </nav>
    </>
  );
}
