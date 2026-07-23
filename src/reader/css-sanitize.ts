/**
 * Sanitize package CSS for injection into chapter documents.
 * Fail closed on remote resources and dangerous constructs.
 */

export const MAX_SINGLE_CSS_BYTES = 256 * 1024;
export const MAX_AGGREGATE_CSS_BYTES = 512 * 1024;
export const MAX_STYLESHEETS_PER_CHAPTER = 12;

/**
 * Sanitize CSS text for active-chapter injection.
 * Removes @import, neutralizes remote/url schemes, strips expression/behavior.
 */
export function sanitizePackageCss(cssText: string): string {
  let css = cssText;

  // Remove @import rules entirely (including url() forms)
  css = css.replace(/@import\s+[^;]+;?/gi, "/* blocked-import */");

  // Neutralize javascript / vbscript / data in url()
  css = css.replace(
    /url\s*\(\s*(['"]?)(\s*(?:javascript|vbscript|data):[^)'"]*)\1\s*\)/gi,
    "url(about:blank)",
  );

  // Neutralize http(s) and protocol-relative urls
  css = css.replace(
    /url\s*\(\s*(['"]?)\s*(?:https?:)?\/\/[^)'"]*\1\s*\)/gi,
    "/* blocked-remote-url */",
  );
  css = css.replace(
    /url\s*\(\s*(['"]?)\s*https?:[^)'"]*\1\s*\)/gi,
    "/* blocked-remote-url */",
  );

  // IE expression / behavior
  css = css.replace(/expression\s*\(/gi, "/*blocked*/(");
  css = css.replace(/behavior\s*:/gi, "/*blocked*/:");
  css = css.replace(/-moz-binding\s*:/gi, "/*blocked*/:");

  return css;
}

/** Whether a stylesheet href is package-local (not remote). */
export function isPackageStylesheetHref(href: string | null | undefined): boolean {
  if (href == null) return false;
  const v = href.trim().toLowerCase();
  if (!v) return false;
  if (v.startsWith("http:") || v.startsWith("https:") || v.startsWith("//")) {
    return false;
  }
  if (v.startsWith("javascript:") || v.startsWith("data:") || v.startsWith("blob:")) {
    return false;
  }
  return true;
}
