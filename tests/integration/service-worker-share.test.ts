// @vitest-environment node
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import viteConfig from "../../vite.config";
import swSource from "../../src/sw.ts?raw";
import viteConfigSource from "../../vite.config.ts?raw";
import {
  handleShareTarget,
  isShareTargetRequest,
} from "../../src/sw/share-import";

const DB_NAME = "books-reader";
const ORIGIN = "https://books.example";

async function deleteDatabase(): Promise<void> {
  await new Promise<void>((resolveDelete, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolveDelete();
    request.onerror = () =>
      reject(request.error ?? new Error("deleteDatabase failed"));
    request.onblocked = () => resolveDelete();
  });
}

function makeEpubFile(name = "shared.epub"): File {
  return new File(["PK\u0003\u0004-epub"], name, {
    type: "application/epub+zip",
  });
}

function sharePost(file: File): Request {
  const form = new FormData();
  form.append("epub", file, file.name);
  return new Request(`${ORIGIN}/share-target`, { method: "POST", body: form });
}

beforeEach(async () => {
  await deleteDatabase();
});

describe("service worker share-target integration", () => {
  it("declares the exact Web App Manifest share_target for EPUB files", () => {
    const plugins = viteConfig.plugins ?? [];
    const pwaPlugin = (plugins as unknown[]).find((plugin) => {
      if (!plugin || typeof plugin !== "object") {
        return false;
      }
      const name = (plugin as { name?: string }).name;
      return typeof name === "string" && name.includes("vite-plugin-pwa");
    });

    expect(viteConfigSource).toMatch(/strategies:\s*["']injectManifest["']/);
    expect(viteConfigSource).toMatch(/filename:\s*["']sw\.ts["']/);
    expect(viteConfigSource).toMatch(/srcDir:\s*["']src["']/);
    expect(viteConfigSource).toMatch(/share_target/);
    expect(viteConfigSource).toMatch(/action:\s*["']\/share-target["']/);
    expect(viteConfigSource).toMatch(/method:\s*["']POST["']/);
    expect(viteConfigSource).toMatch(/enctype:\s*["']multipart\/form-data["']/);
    expect(viteConfigSource).toMatch(/name:\s*["']epub["']/);
    expect(viteConfigSource).toMatch(/application\/epub\+zip/);
    expect(viteConfigSource).toMatch(/["']\.epub["']/);

    // Manifest must not point share handling at a backend/user-data URL.
    expect(viteConfigSource).not.toMatch(/api\.|backend|upload|user-data|graphql/i);

    expect(pwaPlugin || viteConfigSource.includes("VitePWA")).toBeTruthy();
  });

  it("service worker source handles share-target before caching and only uses __WB_MANIFEST", () => {
    expect(swSource).toMatch(/isShareTargetRequest/);
    expect(swSource).toMatch(/handleShareTarget/);
    expect(swSource).toMatch(/event\.respondWith\(\s*handleShareTarget/);
    expect(swSource).toMatch(/precacheAndRoute\(\s*self\.__WB_MANIFEST\s*\)/);
    // Must not invent runtime caches of user EPUB bytes or backend routes.
    expect(swSource).not.toMatch(/caches\.open\(\s*["']epub/i);
    expect(swSource).not.toMatch(/fetch\(\s*event\.request/);
    expect(swSource).not.toMatch(/https?:\/\//i);
  });

  it("intercepts the share POST locally without network fallback", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      throw new Error("network must not be used for share-target POST");
    });

    const request = sharePost(makeEpubFile("novel.epub"));
    expect(isShareTargetRequest(request)).toBe(true);

    const response = await handleShareTarget(request);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(response.status).toBe(303);
    const location = response.headers.get("Location");
    expect(location).toMatch(/\/\?share-import=/);
    // Redirect stays on the same origin — never a backend host.
    expect(new URL(location!).origin).toBe(ORIGIN);
    expect(location).not.toMatch(/api|upload|backend/i);

    fetchSpy.mockRestore();
  });

  it("never stages the body when validation fails (no fetch either)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const form = new FormData();
    form.append(
      "epub",
      new File(["hello"], "notes.txt", { type: "text/plain" }),
      "notes.txt",
    );
    const response = await handleShareTarget(
      new Request(`${ORIGIN}/share-target`, { method: "POST", body: form }),
    );
    expect(response.status).toBe(415);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
