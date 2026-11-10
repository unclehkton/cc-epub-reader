/**
 * Resolve the build identifier that `vite.config.ts` injects as `__BUILD_ID__`.
 *
 * The id must change on every build. A deploy that only edits `public/_headers`
 * (for example the CSP fix) otherwise produces a byte-identical `sw.js`, so an
 * installed PWA never sees a new worker and keeps serving the document it
 * cached at install time.
 */
export interface BuildIdInput {
  /** Explicit override, for example `BUILD_ID` in a release pipeline. */
  override?: string | undefined;
  /** Commit reported by CI, for example `GITHUB_SHA`. */
  ciCommit?: string | undefined;
  /** Commit resolved with `git rev-parse --short HEAD`. */
  localCommit?: string | undefined;
  /** Clock for the per-build suffix. Injectable so tests stay deterministic. */
  now?: Date;
}

const UNSAFE = /[^A-Za-z0-9._-]+/g;
const FALLBACK_COMMIT = "local";
const SHORT_COMMIT_LENGTH = 7;

function sanitize(value: string): string {
  return value.trim().replace(UNSAFE, "-").replace(/^-+|-+$/g, "");
}

/** `2026-11-10T09:12:33.456Z` becomes `20261110T091233456Z`. */
function stampUtc(date: Date): string {
  return date.toISOString().replace(/[-:.]/g, "");
}

export function resolveBuildId(input: BuildIdInput = {}): string {
  const override = input.override ? sanitize(input.override) : "";
  if (override) {
    return override;
  }

  const commit =
    sanitize(input.ciCommit ?? "").slice(0, SHORT_COMMIT_LENGTH) ||
    sanitize(input.localCommit ?? "").slice(0, SHORT_COMMIT_LENGTH) ||
    FALLBACK_COMMIT;

  return `${commit}-${stampUtc(input.now ?? new Date())}`;
}
