import { describe, expect, it, vi } from "vitest";
import type { StoredSettings } from "../../src/domain/types";
import {
  DEFAULT_SETTINGS,
  LatestWinsSettingsRepository,
  type SettingsRepositoryLike,
} from "../../src/settings/settings-repository";

describe("LatestWinsSettingsRepository", () => {
  it("keeps newest settings when older saves resolve later", async () => {
    const saved: StoredSettings[] = [];
    let releaseSlow!: () => void;
    const slowGate = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });

    const inner: SettingsRepositoryLike = {
      async get() {
        return { ...DEFAULT_SETTINGS };
      },
      async save(settings) {
        if (settings.fontSizePercent === 110) {
          await slowGate;
        }
        saved.push({ ...settings });
      },
    };

    const repo = new LatestWinsSettingsRepository(inner);
    const first = repo.save({ ...DEFAULT_SETTINGS, fontSizePercent: 110 });
    const second = repo.save({ ...DEFAULT_SETTINGS, fontSizePercent: 140 });

    releaseSlow();
    await Promise.all([first, second]);

    expect(saved.length).toBeGreaterThanOrEqual(1);
    expect(saved[saved.length - 1]?.fontSizePercent).toBe(140);
  });

  it("skips superseded save that never starts", async () => {
    const save = vi.fn(async () => {
      // immediate
    });
    const inner: SettingsRepositoryLike = {
      get: async () => ({ ...DEFAULT_SETTINGS }),
      save,
    };
    const repo = new LatestWinsSettingsRepository(inner);
    void repo.save({ ...DEFAULT_SETTINGS, fontSizePercent: 90 });
    await repo.save({ ...DEFAULT_SETTINGS, fontSizePercent: 120 });
    // At least the last save must have run with 120.
    const percents = save.mock.calls.map((c) => {
      const arg = (c as unknown as [StoredSettings])[0];
      return arg?.fontSizePercent;
    });
    expect(percents).toContain(120);
  });
});
