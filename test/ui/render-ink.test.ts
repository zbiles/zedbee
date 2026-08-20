import { performance } from "node:perf_hooks";
import { describe, expect, it, vi } from "vitest";
import {
  INK_MINIMUM_DISPLAY_MS,
  inkMaxFps,
  runInkScan,
} from "../../src/ui/render-ink.js";
import { createGitRepository } from "../helpers/git-repository.js";

describe("runInkScan", () => {
  it("retains the 400 ms minimum live-dashboard duration", () => {
    expect(INK_MINIMUM_DISPLAY_MS).toBe(400);
  });

  it("keeps the animated live interface visible before the compact report", async () => {
    const repository = await createGitRepository("zedbee-ink-timing-");
    await repository.write(
      "package.json",
      '{"name":"ink-timing-fixture","private":true}\n',
    );
    await repository.commitAll("fixture setup");
    const startedAt = performance.now();
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(((
      ...args: unknown[]
    ) => {
      const callback = args.find((value) => typeof value === "function");
      if (typeof callback === "function")
        queueMicrotask(callback as () => void);
      return true;
    }) as typeof process.stdout.write);

    try {
      const report = await runInkScan(
        { repositoryRoot: repository.root },
        { color: false, animations: true, width: 120 },
      );

      expect(report.checks).toHaveLength(0);
      expect(performance.now() - startedAt).toBeGreaterThanOrEqual(390);
    } finally {
      stdout.mockRestore();
    }
  });

  it("keeps event-driven rerenders responsive when animation is disabled", () => {
    expect(inkMaxFps(false)).toBeGreaterThan(1);
    expect(inkMaxFps(false)).toBe(inkMaxFps(true));
  });

  it("does not impose the animated minimum display time without animation", async () => {
    const repository = await createGitRepository("zedbee-ink-no-animation-");
    await repository.write(
      "package.json",
      '{"name":"ink-no-animation-fixture","private":true}\n',
    );
    await repository.commitAll("fixture setup");
    const startedAt = performance.now();
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(((
      ...args: unknown[]
    ) => {
      const callback = args.find((value) => typeof value === "function");
      if (typeof callback === "function")
        queueMicrotask(callback as () => void);
      return true;
    }) as typeof process.stdout.write);

    try {
      await runInkScan(
        { repositoryRoot: repository.root },
        { color: false, animations: false, width: 120 },
      );

      expect(performance.now() - startedAt).toBeLessThan(
        INK_MINIMUM_DISPLAY_MS,
      );
    } finally {
      stdout.mockRestore();
    }
  });
});
