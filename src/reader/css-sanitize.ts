/**
 * Sanitize package CSS for injection into chapter documents.
 * Fail closed on remote resources and dangerous constructs.
 */

export const MAX_SINGLE_CSS_BYTES = 256 * 1024;
export const MAX_AGGREGATE_CSS_BYTES = 512 * 1024;
export const MAX_STYLESHEETS_PER_CHAPTER = 12;

/**
 * Sanitize CSS text for active-chapter injection.
 * Removes @import (incl. escaped forms), neutralizes ALL non-blob/data urls
 * (package-relative images must not auto-fetch before tap-to-reveal), strips
 * expression/behavior.
 */
export function sanitizePackageCss(cssText: string): string {
  let css = cssText;

  // Remove @import rules (plain and common CSS escape forms of "import")
  css = css.replace(/@import\s+[^;]+;?/gi, "/* blocked-import */");
  css = css.replace(/@\\69\s*mport\s+[^;]+;?/gi, "/* blocked-import */");
  css = css.replace(/@\\49\s*mport\s+[^;]+;?/gi, "/* blocked-import */");

  // Neutralize every url(...) that is not already blob: or data: (fail closed).
  // Package-relative url(../Images/x.png) would otherwise decode before reveal.
  css = css.replace(/url\s*\(\s*(['"]?)([^)'"]*)\1\s*\)/gi, (_full, _q, raw: string) => {
    const value = String(raw ?? "").trim();
    if (!value) return "url(about:blank)";
    const lower = value.toLowerCase();
    if (lower.startsWith("blob:") || lower.startsWith("data:")) {
      // data: with scriptable types still blocked
      if (lower.startsWith("data:text/html") || lower.startsWith("data:image/svg")) {
        return "url(about:blank)";
      }
      return `url(${value})`;
    }
    return "url(about:blank)";
  });

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
