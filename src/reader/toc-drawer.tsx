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
  onSelect: (href: string) => void;
  onClose: () => void;
}

export function TocDrawer({
  open,
  entries,
  activeHref,
  sidePanel = false,
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
          aria-label="關閉目錄"
          onClick={onClose}
        />
      ) : null}
      <nav
        class={className}
        aria-label="目錄"
        hidden={sidePanel ? false : !open}
      >
        <div class="toc-drawer-header">
          <h2 class="toc-drawer-title">目錄</h2>
          {!sidePanel ? (
            <button
              type="button"
              class="toc-close touch-target"
              style={{ minWidth: "44px", minHeight: "44px" }}
              aria-label="關閉目錄"
              onClick={onClose}
            >
              關閉
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
