import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../../src/cli.js";
import { startTelemetry } from "../../src/telemetry/client.js";
import { TelemetryStore } from "../../src/telemetry/state.js";
import { updateHuskyHook } from "../../src/hooks/husky.js";
import { updateSimpleGitHooksManifest } from "../../src/hooks/simple-git-hooks.js";
import { updateLefthookConfig } from "../../src/hooks/lefthook.js";
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  roots.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true }));
});
describe("CLI telemetry integration", () => {
  it.each([
    { code: 1, applied: 0, outcome: "incomplete" },
    { code: 1, applied: 2, outcome: "incomplete" },
    { code: 0, applied: 2, outcome: "applied" },
    { code: 2, applied: 2, outcome: "incomplete" },
    { code: 130, applied: 2, outcome: "cancelled" },
  ])(
    "records fix exit $code with $applied applied as $outcome",
    async ({ code, applied, outcome }) => {
      const root = mkdtempSync(join(tmpdir(), "telemetry-fix-result-"));
      roots.push(root);
      const store = new TelemetryStore(join(root, "state"));
      const result = await runCli(
        ["node", "zedbee", "fix", "--yes", "--format", "json"],
        {
          startTelemetry: (options) =>
            startTelemetry({
              ...options,
              env: {},
              store,
              notice: () => {},
              launch: () => {},
            }),
          executeFixCommand: async (options) => {
            options.telemetrySummary?.({
              outcome: "applied",
              applied_count: applied,
            });
            return code as 0 | 1 | 2;
          },
        },
      );
      expect(result).toBe(code);
      expect(store.pending()).toHaveLength(1);
      expect(store.pending()[0]).toMatchObject({
        event: "fix_finished",
        outcome,
        applied_count: applied,
      });
    },
  );

  it("interrupts a pending CI flush without delaying CLI cancellation", async () => {
    vi.useFakeTimers();
    const root = mkdtempSync(join(tmpdir(), "telemetry-cli-"));
    roots.push(root);
    let signal: AbortSignal | undefined;
    let result: number | undefined;
    const running = runCli(["node", "zedbee", "scan", "--format", "json"], {
      startTelemetry: (options) =>
        startTelemetry({
          ...options,
          env: { CI: "1" },
          store: new TelemetryStore(join(root, "state")),
          notice: () => {},
          send: async (_events, value) => {
            signal = value;
            return new Promise<boolean>(() => {});
          },
        }),
      executeScanCommand: async () => 0,
    }).then((value) => {
      result = value;
    });
    await vi.advanceTimersByTimeAsync(20);
    process.emit("SIGINT");
    await vi.advanceTimersByTimeAsync(0);
    expect(signal?.aborted).toBe(true);
    expect(result).toBe(130);
    await running;
  });

  it("emits exactly one scan pair with final outcome and hook attribution", async () => {
    const root = mkdtempSync(join(tmpdir(), "telemetry-cli-"));
    roots.push(root);
    const store = new TelemetryStore(join(root, "state"));
    expect(
      await runCli(
        ["node", "zedbee", "scan", "--hook-invocation", "--format", "json"],
        {
          startTelemetry: (options) =>
            startTelemetry({
              ...options,
              env: {},
              store,
              notice: () => {},
              launch: () => {},
            }),
          executeScanCommand: async (options) => {
            options.telemetrySummary?.({
              finding_count: 4,
              check_ids: ["types"],
            });
            return 2;
          },
        },
      ),
    ).toBe(2);
    expect(store.pending().map((e) => e.event)).toEqual([
      "scan_started",
      "scan_finished",
    ]);
    expect(store.pending()[1]).toMatchObject({
      invocation_source: "git_hook",
      outcome: "incomplete",
      finding_count: 4,
    });
  });
  it("ignores help and does not interpret a fix's internal work as another scan", async () => {
    const root = mkdtempSync(join(tmpdir(), "telemetry-cli-"));
    roots.push(root);
    const store = new TelemetryStore(join(root, "state"));
    let starts = 0;
    const starter: typeof startTelemetry = (options) => {
      starts++;
      return startTelemetry({
        ...options,
        env: {},
        store,
        notice: () => {},
        launch: () => {},
      });
    };
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await expect(
      runCli(["node", "zedbee", "--help"], { startTelemetry: starter }),
    ).rejects.toMatchObject({ code: "commander.helpDisplayed" });
    expect(starts).toBe(0);
    await runCli(["node", "zedbee", "fix", "--format", "json"], {
      startTelemetry: starter,
      executeFixCommand: async (options) => {
        options.telemetrySummary?.({ outcome: "applied", applied_count: 2 });
        return 0;
      },
    });
    expect(store.pending().map((e) => e.event)).toEqual(["fix_finished"]);
    expect(store.pending()[0]).toMatchObject({
      outcome: "applied",
      applied_count: 2,
    });
  });
  it("generated hooks mark scans while preserving legacy hooks and idempotence", () => {
    const hook = updateHuskyHook(null);
    expect(hook).toContain("scan --hook-invocation");
    expect(updateHuskyHook(hook)).toBe(hook);
    const legacy = "#!/bin/sh\nnpx --no-install zedbee scan\n";
    expect(updateHuskyHook(legacy)).toBe(legacy);
    const manifest = updateSimpleGitHooksManifest("{}");
    expect(manifest).toContain("scan --hook-invocation");
    expect(updateLefthookConfig(null)).toContain("scan --hook-invocation");
  });
});
