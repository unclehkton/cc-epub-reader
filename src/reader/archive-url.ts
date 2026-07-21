/**
 * Archive-local URL policy for chapter transforms.
 *
 * Only relative, non-network references may reach an ArchiveResolver.
 * Absolute http(s), protocol-relative, javascript:, and other scheme URLs
 * are rejected before any archive lookup.
 */

export type ArchiveResolver = (rawUrl: string) => string | null;

const ABSOLUTE_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

/**
 * Returns true when `raw` must never be fetched or restored as a chapter resource.
 */
export function isRejectedUrl(raw: string | null | undefined): boolean {
  if (raw == null) return true;
  const value = raw.trim();
  if (!value) return true;

  const lower = value.toLowerCase();
  if (lower.startsWith("javascript:")) return true;
  if (lower.startsWith("vbscript:")) return true;
  if (lower.startsWith("data:")) return true;
  if (lower.startsWith("blob:")) {
    // Blob URLs are only restorable when produced by the archive resolver itself,
    // never when they appear as raw markup attributes from the EPUB.
    return true;
  }
  if (value.startsWith("//")) return true;
  if (lower.startsWith("http:") || lower.startsWith("https:")) return true;

  // Any other absolute scheme (file:, about:, etc.) is unsafe as EPUB markup.
  if (ABSOLUTE_SCHEME.test(value)) return true;

  return false;
}

/**
 * Normalize a raw attribute value for archive resolution.
 * Returns null when the candidate is empty or policy-rejected.
 */
export function normalizeArchiveCandidate(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const value = raw.trim();
  if (!value) return null;
  if (isRejectedUrl(value)) return null;
  return value;
}

/**
 * Apply policy, then the caller-supplied archive resolver.
 * Never returns a rejected scheme even if the resolver misbehaves.
 */
export function resolveArchiveCandidate(
  raw: string | null | undefined,
  resolve: ArchiveResolver,
): string | null {
  const candidate = normalizeArchiveCandidate(raw);
  if (candidate == null) return null;

  let resolved: string | null;
  try {
    resolved = resolve(candidate);
  } catch {
    return null;
  }

  if (resolved == null) return null;
  const out = String(resolved).trim();
  if (!out) return null;

  // Resolver may return blob: archive object URLs; those are intentional.
  // Still block javascript: / network schemes from a compromised resolver.
  const lower = out.toLowerCase();
  if (lower.startsWith("javascript:") || lower.startsWith("vbscript:")) return null;
  if (lower.startsWith("http:") || lower.startsWith("https:")) return null;
  if (out.startsWith("//")) return null;

  return out;
}

/**
 * Parse an HTML srcset and keep only archive-approved descriptors.
 * Returns null when nothing remains.
 */
export function resolveArchiveSrcset(
  rawSrcset: string | null | undefined,
  resolve: ArchiveResolver,
): string | null {
  if (rawSrcset == null) return null;
  const input = rawSrcset.trim();
  if (!input) return null;

  const parts = input.split(",");
  const kept: string[] = [];

  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    // URL is first token; remaining tokens are width/density descriptors.
    const tokens = trimmed.split(/\s+/);
    const url = tokens[0];
    if (!url) continue;
    const resolved = resolveArchiveCandidate(url, resolve);
    if (resolved == null) continue;
    const descriptors = tokens.slice(1).join(" ");
    kept.push(descriptors ? `${resolved} ${descriptors}` : resolved);
  }

  return kept.length > 0 ? kept.join(", ") : null;
}

/**
 * Validate a value that was previously stored in data-epub-* before restoring it
 * onto a live fetch attribute. Blocks network/javascript even if attributes were tampered.
 */
export function validateRestorableUrl(stored: string | null | undefined): string | null {
  if (stored == null) return null;
  const value = stored.trim();
  if (!value) return null;

  const lower = value.toLowerCase();
  if (lower.startsWith("javascript:") || lower.startsWith("vbscript:")) return null;
  if (lower.startsWith("http:") || lower.startsWith("https:")) return null;
  if (value.startsWith("//")) return null;
  // data: is not archive-local restore material for this product.
  if (lower.startsWith("data:")) return null;

  // Allow blob: (EPUB.js archive object URLs) and relative/package paths.
  return value;
}
