import { describe, expect, it } from "vitest";
import { resolveBuildId } from "../../src/platform/build-id";

const NOW = new Date("2026-11-10T09:12:33.456Z");

describe("resolveBuildId", () => {
  it("stamps the local commit with the build time in UTC", () => {
    expect(resolveBuildId({ localCommit: "d42e0d3", now: NOW })).toBe(
      "d42e0d3-20261110T091233456Z",
    );
  });

  it("prefers the CI commit and shortens it to seven characters", () => {
    expect(
      resolveBuildId({
        ciCommit: "0123456789abcdef0123456789abcdef01234567",
        localCommit: "d42e0d3",
        now: NOW,
      }),
    ).toBe("0123456-20261110T091233456Z");
  });

  it("honors an explicit override without appending a timestamp", () => {
    expect(
      resolveBuildId({ override: "release-2026.11.10", now: NOW }),
    ).toBe("release-2026.11.10");
  });

  it("ignores a blank override", () => {
    expect(resolveBuildId({ override: "   ", now: NOW })).toBe(
      "local-20261110T091233456Z",
    );
  });

  it("falls back to local when no commit is available", () => {
    expect(resolveBuildId({ now: NOW })).toBe("local-20261110T091233456Z");
  });

  it("sanitizes unsafe characters so the id stays one token", () => {
    const id = resolveBuildId({
      override: "  feature/release 0.1\n\"x\"  ",
      now: NOW,
    });

    expect(id).toMatch(/^[A-Za-z0-9._-]+$/);
    expect(id).toBe("feature-release-0.1-x");
  });

  it("changes on every build even for the same commit", () => {
    const first = resolveBuildId({ localCommit: "d42e0d3", now: NOW });
    // A rebuild one millisecond later must still produce a new id.
    const second = resolveBuildId({
      localCommit: "d42e0d3",
      now: new Date("2026-11-10T09:12:33.457Z"),
    });

    expect(first).not.toBe(second);
  });
});
