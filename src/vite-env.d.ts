/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

declare module "*?raw" {
  const content: string;
  export default content;
}

/** Workbox injectManifest precache injection point. */
interface ServiceWorkerGlobalScope {
  __WB_MANIFEST: Array<string | { url: string; revision: string | null }>;
}
