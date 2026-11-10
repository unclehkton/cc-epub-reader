import { execFileSync } from "node:child_process";
import preact from "@preact/preset-vite";
import type { Plugin } from "vite";
import { VitePWA } from "vite-plugin-pwa";
import { defineConfig } from "vitest/config";
import { resolveBuildId } from "./src/platform/build-id";

function localCommit(): string | undefined {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    // No git checkout (tarball, container): the id falls back to "local".
    return undefined;
  }
}

/**
 * Injected as `__BUILD_ID__`. It changes on every build so each deploy ships a
 * new `sw.js`; without that, an installed PWA keeps serving the document it
 * cached at install and never sees a release that only edits `public/_headers`.
 */
const buildId = resolveBuildId({
  override: process.env.BUILD_ID,
  ciCommit: process.env.GITHUB_SHA,
  localCommit: localCommit(),
});

/** Publish the id in the document so a live deploy can be identified with curl. */
function buildIdMeta(): Plugin {
  return {
    name: "books-build-id",
    transformIndexHtml: () => [
      {
        tag: "meta",
        attrs: { name: "build-id", content: buildId },
        injectTo: "head-prepend",
      },
    ],
  };
}

export default defineConfig({
  define: {
    __BUILD_ID__: JSON.stringify(buildId),
  },
  plugins: [
    buildIdMeta(),
    preact(),
    VitePWA({
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.ts",
      registerType: "prompt",
      injectRegister: null,
      includeAssets: [
        "icons/icon-192.png",
        "icons/icon-512.png",
        "icons/maskable-512.png",
      ],
      manifest: {
        name: "Books",
        short_name: "Books",
        display: "standalone",
        start_url: "/",
        scope: "/",
        theme_color: "#1a2e1a",
        background_color: "#f5f0e6",
        icons: [
          {
            src: "icons/icon-192.png",
            sizes: "192x192",
            type: "image/png",
          },
          {
            src: "icons/icon-512.png",
            sizes: "512x512",
            type: "image/png",
          },
          {
            src: "icons/maskable-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
        share_target: {
          action: "/share-target",
          method: "POST",
          enctype: "multipart/form-data",
          params: {
            files: [
              {
                name: "epub",
                accept: ["application/epub+zip", ".epub"],
              },
            ],
          },
        },
      },
      injectManifest: {
        globPatterns: ["**/*.{js,css,html,ico,png,svg,woff2,webmanifest}"],
      },
      devOptions: {
        enabled: false,
      },
    }),
  ],
  build: {
    target: "es2019",
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    globals: true,
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/tests/e2e/**",
      "**/*.e2e.*",
    ],
  },
});
