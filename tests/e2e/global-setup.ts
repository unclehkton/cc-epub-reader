import { chromium, webkit } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

interface BrowserHandle {
  close(): Promise<void>;
}

export interface BrowserLauncher {
  name: string;
  launch(): Promise<BrowserHandle>;
}

const DEFAULT_LAUNCH_TIMEOUT_MS = 30_000;
const INSTALL_COMMAND = "npx playwright install chromium webkit";
const PREVIEW_URL = "http://127.0.0.1:4173";
const PREVIEW_PID_ENV = "PLAYWRIGHT_OWNED_PREVIEW_PID";
const DEFAULT_PREVIEW_TIMEOUT_MS = 30_000;

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function previewIsReady(): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1_000);
  try {
    const response = await fetch(PREVIEW_URL, { signal: controller.signal });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

function stopChild(child: ChildProcess): void {
  if (child.exitCode === null && !child.killed) {
    child.kill();
  }
}

export async function startPreviewServer(
  timeoutMs = DEFAULT_PREVIEW_TIMEOUT_MS,
): Promise<ChildProcess | undefined> {
  if (await previewIsReady()) {
    if (process.env.CI) {
      throw new Error(`${PREVIEW_URL} is already in use before the E2E run`);
    }
    return undefined;
  }

  const viteCli = fileURLToPath(
    new URL("../../node_modules/vite/bin/vite.js", import.meta.url),
  );
  const child = spawn(
    process.execPath,
    [
      viteCli,
      "preview",
      "--host",
      "127.0.0.1",
      "--port",
      "4173",
      "--strictPort",
    ],
    {
      cwd: process.cwd(),
      stdio: ["ignore", "inherit", "inherit"],
      windowsHide: true,
    },
  );

  process.env[PREVIEW_PID_ENV] = String(child.pid);
  const stopOnExit = () => stopChild(child);
  process.once("exit", stopOnExit);

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      process.removeListener("exit", stopOnExit);
      throw new Error(`Vite preview exited with code ${child.exitCode}`);
    }
    if (await previewIsReady()) return child;
    await delay(200);
  }

  stopChild(child);
  process.removeListener("exit", stopOnExit);
  throw new Error(`Vite preview did not become ready within ${timeoutMs} ms`);
}

function launchWithTimeout(
  launcher: BrowserLauncher,
  timeoutMs: number,
): Promise<BrowserHandle> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${launcher.name} launch timed out after ${timeoutMs} ms`));
    }, timeoutMs);

    void launcher.launch().then(
      (browser) => {
        clearTimeout(timer);
        resolve(browser);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export async function verifyBrowserLaunchers(
  launchers: readonly BrowserLauncher[],
  timeoutMs = DEFAULT_LAUNCH_TIMEOUT_MS,
): Promise<void> {
  for (const launcher of launchers) {
    let browser: BrowserHandle | undefined;
    try {
      browser = await launchWithTimeout(launcher, timeoutMs);
    } catch (error: unknown) {
      const detail = error instanceof Error ? ` (${error.message})` : "";
      throw new Error(
        `${launcher.name} could not launch. Run: ${INSTALL_COMMAND}${detail}`,
      );
    } finally {
      await browser?.close();
    }
  }
}

export default async function globalSetup(): Promise<void> {
  const preview = await startPreviewServer();
  try {
    await verifyBrowserLaunchers([
      { name: "Chromium", launch: () => chromium.launch({ headless: true }) },
      { name: "WebKit", launch: () => webkit.launch({ headless: true }) },
    ]);
  } catch (error: unknown) {
    if (preview) stopChild(preview);
    throw error;
  }
}
