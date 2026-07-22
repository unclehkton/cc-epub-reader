import { describe, expect, it } from "vitest";
import headers from "../../public/_headers?raw";
import redirects from "../../public/_redirects?raw";

function extractCsp(source: string): string {
  const match = source.match(/Content-Security-Policy:\s*(.+)/i);
  expect(match, "Content-Security-Policy header must be present").toBeTruthy();
  return match![1]!.trim();
}

/** Host fragments that must never appear in connect-src / CSP for this privacy app. */
const ANALYTICS_OR_REMOTE_HOST_FRAGMENTS = [
  "google-analytics",
  "googletagmanager",
  "google.com",
  "segment.",
  "plausible",
  "mixpanel",
  "hotjar",
  "facebook",
  "doubleclick",
  "cloudflareinsights",
  "sentry.io",
  "amplitude",
];

describe("Cloudflare Pages deployment config", () => {
  describe("public/_headers", () => {
    it("includes nosniff and strict referrer policy", () => {
      expect(headers).toMatch(/X-Content-Type-Options:\s*nosniff/i);
      expect(headers).toMatch(/Referrer-Policy:\s*no-referrer/i);
    });

    it("prevents Cloudflare from injecting analytics into static responses", () => {
      const cacheControl = headers.match(/Cache-Control:\s*(.+)/i)?.[1] ?? "";

      expect(cacheControl).toMatch(/(?:^|,)\s*public\s*(?:,|$)/i);
      expect(cacheControl).toMatch(/(?:^|,)\s*no-transform\s*(?:,|$)/i);
    });

    it("ships a CSP that starts at default-src 'self' with narrow connect-src", () => {
      const csp = extractCsp(headers);

      expect(csp.startsWith("default-src 'self'")).toBe(true);
      expect(csp).toMatch(/connect-src\s+'self'(?:\s*;|$)/);

      // connect-src must not list any extra host
      const connect = csp.match(/connect-src\s+([^;]+)/i);
      expect(connect).toBeTruthy();
      expect(connect![1]!.trim()).toBe("'self'");
    });

    it("includes the approved baseline directives and no analytics hosts", () => {
      const csp = extractCsp(headers);

      expect(csp).toMatch(/script-src\s+'self'/);
      expect(csp).toMatch(/style-src\s+'self'\s+'unsafe-inline'/);
      expect(csp).toMatch(/img-src\s+'self'\s+blob:\s+data:/);
      expect(csp).toMatch(/font-src\s+'self'\s+data:/);
      expect(csp).toMatch(/object-src\s+'none'/);
      expect(csp).toMatch(/base-uri\s+'none'/);
      expect(csp).toMatch(/form-action\s+'self'/);
      expect(csp).toMatch(/frame-ancestors\s+'none'/);

      const lower = csp.toLowerCase();
      for (const fragment of ANALYTICS_OR_REMOTE_HOST_FRAGMENTS) {
        expect(lower, `CSP must not mention ${fragment}`).not.toContain(fragment);
      }
      // No http(s) host allowlists in the whole policy
      expect(csp).not.toMatch(/https?:\/\//i);
    });

    it("only allows blob: on proven directives (img-src; no broad wildcards)", () => {
      const csp = extractCsp(headers);

      // img-src already requires blob: for EPUB archive object URLs
      expect(csp).toMatch(/img-src[^;]*\bblob:/);

      // No wildcard sources
      expect(csp).not.toMatch(
        /(?:default-src|script-src|style-src|img-src|font-src|connect-src|frame-src|child-src|worker-src)[^;]*\*/,
      );

      // blob: must not appear on script-src unless narrowly documented; baseline forbids it
      const scriptSrc = csp.match(/script-src\s+([^;]+)/i)?.[1] ?? "";
      expect(scriptSrc).not.toMatch(/\bblob:/);

      // If frame-src/child-src are present, blob: is only allowed when intentionally listed;
      // default path uses srcdoc, so absence of frame-src blob: is preferred.
      const frameSrc = csp.match(/frame-src\s+([^;]+)/i)?.[1];
      if (frameSrc) {
        // Prefer not adding blob: unless proven; if present it must still be narrow (no *)
        expect(frameSrc).not.toMatch(/\*/);
      }
    });
  });

  describe("public/_redirects", () => {
    it("falls back SPA GET navigation to /index.html 200", () => {
      expect(redirects).toMatch(/\/\*\s+\/index\.html\s+200\b/);
    });

    it("does not treat /share-target as a server POST handler", () => {
      const activeLines = redirects
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith("#"));

      for (const line of activeLines) {
        if (!/share-target/i.test(line)) continue;
        // No backend, Functions, or API rewrite for share-target
        expect(line).not.toMatch(/\/api\b/i);
        expect(line).not.toMatch(/functions/i);
        expect(line).not.toMatch(/worker/i);
        // Must not claim a dedicated status rewrite that pretends to process the POST
        expect(line).not.toMatch(/^\/share-target\b/i);
      }

      // Document that POST is service-worker only (static hosting has no POST processor)
      expect(redirects.toLowerCase()).toMatch(/service worker|service-worker|sw-only|sw only/);
    });
  });
});
