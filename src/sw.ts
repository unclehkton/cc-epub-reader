/// <reference lib="webworker" />
import { clientsClaim } from "workbox-core";
import { cleanupOutdatedCaches, precacheAndRoute } from "workbox-precaching";
import { handleShareTarget, isShareTargetRequest } from "./sw/share-import";

declare let self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<string | { url: string; revision: string | null }>;
};

// Stamped on every build by vite.config.ts. Its presence makes sw.js differ
// between deploys, which is what lets an installed PWA detect the update.
const BUILD_ID = typeof __BUILD_ID__ === "undefined" ? "dev" : __BUILD_ID__;

self.addEventListener("install", () => {
  console.info(`[sw] build ${BUILD_ID}`);
});

// Allow the app to request activation of a waiting worker without
// forcing reload mid-read; skipWaiting still runs on install for first control.
self.addEventListener("message", (event) => {
  if (!event.data || typeof event.data.type !== "string") {
    return;
  }

  if (event.data.type === "SKIP_WAITING") {
    void self.skipWaiting();
    return;
  }

  // On-device diagnostics: which worker build is actually running.
  if (event.data.type === "GET_BUILD_ID") {
    void (event.source as Client | null)?.postMessage({
      type: "BUILD_ID",
      buildId: BUILD_ID,
    });
  }
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// Share-target must win over any later caching / network fall-through.
// The POST body is handled locally and never forwarded with fetch().
self.addEventListener("fetch", (event) => {
  if (isShareTargetRequest(event.request)) {
    event.respondWith(handleShareTarget(event.request));
  }
});

// Precache only the build-injected application asset manifest.
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();
clientsClaim();
