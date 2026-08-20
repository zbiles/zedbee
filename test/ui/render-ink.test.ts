import { performance } from "node:perf_hooks";
import { describe, expect, it, vi } from "vitest";
import {
  INK_MINIMUM_DISPLAY_MS,
  inkMaxFps,
  runInkScan,
} from "../../src/ui/render-ink.js";
import { createGitRepository } from "../helpers/git-repository.js";
import { createFinding } from "../helpers/scan-report.js";

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

  it("prepares the completed scan before flushing the final Ink frame", async () => {
    const repository = await createGitRepository("zedbee-ink-presentation-");
    await repository.write(
      "package.json",
      '{"name":"ink-presentation-fixture","private":true}\n',
    );
    await repository.commitAll("fixture setup");
    const output: string[] = [];
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(((
      ...args: unknown[]
    ) => {
      output.push(String(args[0] ?? ""));
      const callback = args.find((value) => typeof value === "function");
      if (typeof callback === "function")
        queueMicrotask(callback as () => void);
      return true;
    }) as typeof process.stdout.write);
    const store = {
      maintain: vi.fn(async () => ({ warnings: [] })),
    };
    const preparePresentation = vi.fn(async (_report, options) => {
      expect(options).toMatchObject({
        requestedFormat: "ink",
        selectedFormat: "ink",
        store,
      });
      return {
        findings: [createFinding({ rule: "shown-rule" })],
        totalFindingCount: 2,
        abbreviated: true,
        reportPath: "/tmp/zedbee-reports/hash/complete.json",
        maximumAge: "24h",
        warnings: [
          {
            code: "TEMP_REPORT_CLEANUP_FAILED" as const,
            message: "An expired report remains.",
          },
        ],
      };
    });

    try {
      await runInkScan(
        { repositoryRoot: repository.root },
        { color: false, animations: false, width: 120 },
        { preparePresentation, store },
      );
    } finally {
      stdout.mockRestore();
    }

    const rendered = output.join("");
    expect(preparePresentation).toHaveBeenCalledOnce();
    expect(rendered).toContain("shown-rule");
    expect(rendered).toContain("REPORT MAINTENANCE WARNING");
    expect(rendered).toContain("NEXT STEPS");
  });
});
