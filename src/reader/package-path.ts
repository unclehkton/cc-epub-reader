/**
 * Section-relative package path normalization for EPUB archives.
 * POSIX-style only; rejects traversal outside archive root and network schemes.
 */

const ABSOLUTE_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

/**
 * Directory of a package path (POSIX). Trailing slash preserved as empty last segment.
 * `OEBPS/Text/ch1.xhtml` → `OEBPS/Text`
 */
export function packageDir(sectionHref: string): string {
  const cleaned = stripQueryFragment(sectionHref).replace(/\\/g, "/");
  const idx = cleaned.lastIndexOf("/");
  if (idx < 0) return "";
  return cleaned.slice(0, idx);
}

export function stripQueryFragment(raw: string): string {
  const noHash = raw.split("#")[0] ?? raw;
  const noQuery = noHash.split("?")[0] ?? noHash;
  return noQuery.trim();
}

/**
 * Join section directory + relative href into a normalized package path.
 * Returns null if the path escapes the archive root or is unsafe.
 */
export function resolvePackagePath(
  sectionHref: string,
  relativeHref: string,
): string | null {
  const raw = stripQueryFragment(relativeHref).replace(/\\/g, "/").trim();
  if (!raw) return null;

  // Reject schemes and protocol-relative
  if (ABSOLUTE_SCHEME.test(raw) || raw.startsWith("//")) return null;
  // Reject absolute-from-root style that could confuse ZIP maps
  if (raw.startsWith("/")) return null;

  let base = packageDir(sectionHref);
  // Decode percent-encoding for path segments (best-effort)
  let joined = base ? `${base}/${raw}` : raw;
  try {
    joined = joined
      .split("/")
      .map((seg) => {
        try {
          return decodeURIComponent(seg);
        } catch {
          return seg;
        }
      })
      .join("/");
  } catch {
    // keep joined
  }

  return normalizePosixPath(joined);
}

/**
 * Collapse `.` / `..` segments. Returns null if `..` escapes root.
 */
export function normalizePosixPath(path: string): string | null {
  const input = path.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!input) return null;
  if (input.includes("\0")) return null;

  const parts = input.split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    // Reject Windows drive-like segments
    if (/^[a-zA-Z]:$/.test(part)) return null;
    out.push(part);
  }
  if (out.length === 0) return null;
  return out.join("/");
}

/** True if path is a safe archive-relative package path. */
export function isSafePackagePath(path: string): boolean {
  return normalizePosixPath(path) !== null && !ABSOLUTE_SCHEME.test(path);
}
