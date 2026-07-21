const PREVIEW_PID_ENV = "PLAYWRIGHT_OWNED_PREVIEW_PID";

export default function globalTeardown(): void {
  const rawPid = process.env[PREVIEW_PID_ENV];
  if (!rawPid) return;

  const pid = Number(rawPid);
  if (!Number.isSafeInteger(pid) || pid <= 0) return;

  try {
    process.kill(pid);
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ESRCH") throw error;
  } finally {
    delete process.env[PREVIEW_PID_ENV];
  }
}
