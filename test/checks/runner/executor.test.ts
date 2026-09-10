import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { createLocalAnalyzerExecutor } from "../../../src/checks/runner/executor.js";
import { withAnalyzerExecutionSession } from "../../../src/checks/runner/session.js";
import { runAnalyzerJob } from "../../../src/checks/runner/run-job.js";
import { DEFAULT_FORMATTING_SETTINGS } from "../../../src/checks/prettier/settings.js";
import { mkdtemp, writeFile, rm, realpath, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import {
  captureAnalysisSources,
  capturedSourceInput,
  exportAnalysisSourceCapture,
  importAnalysisSourceCapture,
  withAnalysisSourceCapture,
} from "../../../src/inspection/source-capture.js";
import { readContainedFile } from "../../../src/inspection/read-json.js";
import { captureSnapshotRegistry } from "../../../src/inspection/snapshot-registry.js";
import { createInspectionFixture } from "../../inspection/fixture.js";
import { inspectRepository } from "../../../src/inspection/inspect-repository.js";
import { resolveConfig } from "../../../src/config/profiles.js";
import { testFilePolicyResolver } from "../../helpers/file-policy.js";
import { serializeCheckContext } from "../../../src/checks/runner/context.js";
import type { CheckRunContext } from "../../../src/checks/adapter.js";
import { existsSync } from "node:fs";

const workerEntry = fileURLToPath(
  new URL("./fixtures/worker.mjs", import.meta.url),
);
const request = (mode: string) => ({
  version: 1 as const,
  checkId: "formatting" as const,
  operation: "format-working-source" as const,
  input: {
    file: "a.js",
    source: JSON.stringify({ mode }),
    settings: DEFAULT_FORMATTING_SETTINGS,
  },
});

describe("reusable analyzer executor", () => {
  it("runs one network lane while allowing the oldest eligible CPU job to proceed", async () => {
    const root = await mkdtemp(join(tmpdir(), "zedbee-network-lane-"));
    const executor = createLocalAnalyzerExecutor({ concurrency: 2 });
    const session = await executor.openSession();
    const config = resolveConfig({ schemaVersion: 1, profile: "fast" });
    const paths = [0, 1, 2].map((index) => join(root, `${index}.pid`));
    const release = join(root, "release");
    const requests = (
      ["vulnerabilities", "vulnerabilities", "structuralSecurity"] as const
    ).map((checkId, index) => ({
      version: 1 as const,
      checkId,
      operation: "collect" as const,
      context: {
        repositoryRoot: JSON.stringify({ path: paths[index], release }),
        config,
        filePolicyConfig: config,
        policy: config.checks[checkId],
        snapshots: {
          baselineDir: root,
          targetDir: root,
          baselineRef: "HEAD",
          targetRef: "index",
          unsupportedEntries: [],
        },
        baselineInspection: {
          snapshotRoot: root,
          packageManager: "unknown" as const,
          lockfiles: [],
          workspaces: [],
        },
        targetInspection: {
          snapshotRoot: root,
          packageManager: "unknown" as const,
          lockfiles: [],
          workspaces: [],
        },
        changeSet: { files: [], isEmpty: false },
        target: { id: ".", kind: "repository" as const, relativeRoot: "." },
      },
    }));
    const jobs = requests.map((input) => session.run(input, { workerEntry }));
    try {
      await expect
        .poll(() => existsSync(paths[0]!) && existsSync(paths[2]!), {
          timeout: 10000,
        })
        .toBe(true);
      expect(existsSync(paths[1]!)).toBe(false);
      await writeFile(release, "release");
      expect(await Promise.all(jobs)).toHaveLength(3);
      expect(existsSync(paths[1]!)).toBe(true);
      const cpuPid = await readFile(paths[2]!, "utf8");
      await session.close();
      const next = await executor.openSession();
      await next.run(requests[2]!, { workerEntry });
      expect(await readFile(paths[2]!, "utf8")).toBe(cpuPid);
      await next.close();
    } finally {
      await writeFile(release, "release");
      await Promise.allSettled(jobs);
      await executor.close();
      await rm(root, { recursive: true, force: true });
    }
  });
  it.each([1, 2, 4] as const)(
    "enforces the configured %s worker bound with FIFO admission",
    async (concurrency) => {
      const root = await mkdtemp(join(tmpdir(), "zedbee-executor-limit-"));
      const executor = createLocalAnalyzerExecutor({ concurrency });
      const session = await executor.openSession();
      const release = join(root, "release");
      const paths = Array.from({ length: concurrency + 1 }, (_, index) =>
        join(root, `${index}.pid`),
      );
      const jobs = paths.map((path) => {
        const input = request("pid");
        input.input.source = JSON.stringify({ mode: "gate", path, release });
        return session.run(input, { workerEntry });
      });
      try {
        await expect
          .poll(() => paths.slice(0, concurrency).every(existsSync), {
            timeout: 10000,
          })
          .toBe(true);
        expect(existsSync(paths[concurrency]!)).toBe(false);
        await writeFile(release, "release");
        expect(await Promise.all(jobs)).toHaveLength(concurrency + 1);
        expect(existsSync(paths[concurrency]!)).toBe(true);
      } finally {
        await writeFile(release, "release");
        await Promise.allSettled(jobs);
        await executor.close();
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it("rejects excess accepted jobs before reading or cloning another payload", async () => {
    const root = await mkdtemp(join(tmpdir(), "zedbee-admission-"));
    const executor = createLocalAnalyzerExecutor({ concurrency: 1 });
    const session = await executor.openSession();
    const gate = request("pid");
    gate.input.source = JSON.stringify({
      mode: "gate",
      path: join(root, "pid"),
      release: join(root, "release"),
    });
    const jobs = Array.from({ length: 64 }, () =>
      session.run(gate, { workerEntry }).catch((error) => error),
    );
    let reads = 0;
    const excess = request("pid");
    Object.defineProperty(excess.input, "source", {
      enumerable: true,
      get() {
        reads++;
        return "ignored";
      },
    });
    try {
      await expect(session.run(excess, { workerEntry })).rejects.toMatchObject({
        code: "ANALYZER_CAPACITY",
        scope: "job",
      });
      expect(reads).toBe(0);
      await session.close();
      expect(
        (await Promise.all(jobs)).every(
          (value) => value.diagnostic?.category === "cancellation",
        ),
      ).toBe(true);
    } finally {
      await executor.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports failed session reset and retires before another session starts", async () => {
    const executor = createLocalAnalyzerExecutor({ concurrency: 1 });
    const first = await executor.openSession();
    try {
      const pid = JSON.parse(
        await first.run(request("reset-failure"), { workerEntry }),
      ).workerPid;
      await expect(first.close()).rejects.toThrow(/reset/);
      expect(() => process.kill(pid, 0)).toThrow();
      const second = await executor.openSession();
      expect(
        JSON.parse(await second.run(request("pid"), { workerEntry })).workerPid,
      ).not.toBe(pid);
      await second.close();
    } finally {
      await executor.close();
    }
  });
  it("bounds open session admission and rejects oversized payloads before worker startup", async () => {
    const executor = createLocalAnalyzerExecutor({ concurrency: 1 });
    try {
      const sessions = await Promise.all(
        Array.from({ length: 32 }, () => executor.openSession()),
      );
      await expect(executor.openSession()).rejects.toThrow(/capacity/i);
      const oversized = request("pid");
      oversized.input.source = "x".repeat(33 * 1024 * 1024);
      await expect(
        sessions[0]!.run(oversized, { workerEntry }),
      ).rejects.toThrow(/capacity/i);
      await sessions[0]!.close();
      await (await executor.openSession()).close();
    } finally {
      await executor.close();
    }
  });
  it("binds real source bytes to one scan and refreshes the same path for new or unbound sessions", async () => {
    const fixture = await createInspectionFixture();
    await fixture.writeJson("package.json", {
      name: "executor-epoch",
      private: true,
    });
    await fixture.write(
      "src/app.ts",
      "export function branch(value: boolean) { if (value) return 1; return 0; }",
    );
    const inspection = await inspectRepository(fixture.root);
    const config = resolveConfig({
      schemaVersion: 1,
      profile: "fast",
      checks: { cyclomaticComplexity: { max: 1 } },
    });
    const context: CheckRunContext = {
      repositoryRoot: fixture.root,
      snapshots: {
        baselineDir: fixture.root,
        targetDir: fixture.root,
        baselineRef: "HEAD",
        targetRef: "index",
        unsupportedEntries: [],
      },
      baselineInspection: inspection,
      targetInspection: inspection,
      target: { id: ".", kind: "workspace", relativeRoot: "." },
      changeSet: {
        files: new Map([
          [
            "src/app.ts",
            {
              path: "src/app.ts",
              status: "modified",
              addedRanges: [{ start: 1, end: 1 }],
            },
          ],
        ]),
        isEmpty: false,
        containsAddedLine: () => true,
      },
      config,
      policy: config.checks.cyclomaticComplexity,
      policyForFile: testFilePolicyResolver(config),
      signal: new AbortController().signal,
    };
    const input = {
      version: 1 as const,
      checkId: "cyclomaticComplexity" as const,
      operation: "collect" as const,
      context: serializeCheckContext(context),
    };
    const executor = createLocalAnalyzerExecutor({ concurrency: 1 });
    try {
      const first = await executor.openSession({
        sourceSelections: [
          { snapshotRoot: fixture.root, paths: ["src/app.ts"] },
        ],
      });
      await fixture.write(
        "src/app.ts",
        "export function branch() { return 0; }",
      );
      expect(
        (await first.run(input)).targetObservations[0]?.metric?.value,
      ).toBe(2);
      expect(
        (await first.run(input)).targetObservations[0]?.metric?.value,
      ).toBe(2);
      await first.close();
      const second = await executor.openSession({
        sourceSelections: [
          { snapshotRoot: fixture.root, paths: ["src/app.ts"] },
        ],
      });
      expect(
        (await second.run(input)).targetObservations[0]?.metric?.value,
      ).toBe(1);
      await second.close();
      const live = await executor.openSession();
      expect((await live.run(input)).targetObservations[0]?.metric?.value).toBe(
        1,
      );
      await fixture.write(
        "src/app.ts",
        "export function branch(value: boolean) { if (value) return 1; return 0; }",
      );
      expect((await live.run(input)).targetObservations[0]?.metric?.value).toBe(
        2,
      );
      await live.close();
    } finally {
      await executor.close();
    }
  });

  it("cancels one active session while another remains usable and queued cancellation never starts", async () => {
    const root = await mkdtemp(join(tmpdir(), "zedbee-session-cancel-"));
    const executor = createLocalAnalyzerExecutor({ concurrency: 1 });
    const first = await executor.openSession();
    const second = await executor.openSession();
    const input = request("pid");
    const path = join(root, "pids.json");
    input.input.source = JSON.stringify({ mode: "blocked", path });
    const pending = first.run(input, { workerEntry }).catch((error) => error);
    try {
      await expect
        .poll(
          async () => {
            try {
              return JSON.parse(await readFile(path, "utf8"));
            } catch {
              return undefined;
            }
          },
          { timeout: 10000 },
        )
        .toBeDefined();
      const abort = new AbortController();
      const queued = second
        .run(request("pid"), { workerEntry, signal: abort.signal })
        .catch((error) => error);
      abort.abort();
      expect(await queued).toMatchObject({
        diagnostic: { category: "cancellation" },
      });
      await Promise.all([first.close(), first.close()]);
      expect(await pending).toMatchObject({
        diagnostic: { category: "cancellation" },
      });
      const pids = JSON.parse(await readFile(path, "utf8"));
      for (const pid of [pids.workerPid, pids.childPid])
        expect(() => process.kill(pid, 0)).toThrow();
      expect(
        JSON.parse(await second.run(request("pid"), { workerEntry })).workerPid,
      ).toBeGreaterThan(0);
      await second.close();
    } finally {
      await executor.close();
      await rm(root, { recursive: true, force: true });
    }
  });
  it("reuses the supervised worker for related jobs and scoped legacy calls", async () => {
    const executor = createLocalAnalyzerExecutor({ concurrency: 1 });
    const session = await executor.openSession();
    try {
      const first = JSON.parse(
        await session.run(request("pid"), { workerEntry }),
      );
      const second = JSON.parse(
        await withAnalyzerExecutionSession(session, () =>
          runAnalyzerJob(request("pid"), { workerEntry }),
        ),
      );
      expect(first.workerPid).not.toBe(process.pid);
      expect(second.workerPid).toBe(first.workerPid);
    } finally {
      await session.close();
      await executor.close();
    }
    await expect(
      session.run(request("pid"), { workerEntry }),
    ).rejects.toThrow();
  });

  it.each([
    "duplicate",
    "stale",
    "unknown-field",
    "ready-before-result",
    "reply-then-crash",
  ])("rejects %s and retires the worker without retry", async (mode) => {
    const executor = createLocalAnalyzerExecutor({ concurrency: 1 });
    const session = await executor.openSession();
    try {
      await expect(
        session.run(request(mode), { workerEntry }),
      ).rejects.toMatchObject({
        diagnostic: {
          category:
            mode === "reply-then-crash" ? "abnormal-exit" : "invalid-response",
        },
      });
      expect(
        JSON.parse(await session.run(request("pid"), { workerEntry }))
          .workerPid,
      ).toBeGreaterThan(0);
    } finally {
      await session.close();
      await executor.close();
    }
  });

  it("keeps an acknowledged result complete after a later idle crash", async () => {
    const executor = createLocalAnalyzerExecutor({ concurrency: 1 });
    const session = await executor.openSession();
    try {
      const first = JSON.parse(
        await session.run(request("idle-crash"), { workerEntry }),
      );
      await expect
        .poll(() => {
          try {
            process.kill(first.supervisorPid, 0);
            return true;
          } catch {
            return false;
          }
        })
        .toBe(false);
      const second = JSON.parse(
        await session.run(request("pid"), { workerEntry }),
      );
      expect(second.workerPid).not.toBe(first.workerPid);
    } finally {
      await session.close();
      await executor.close();
    }
  });

  it("reuses a healthy PID across explicit session release", async () => {
    const executor = createLocalAnalyzerExecutor({ concurrency: 1 });
    try {
      const first = await executor.openSession();
      const pid = JSON.parse(
        await first.run(request("pid"), { workerEntry }),
      ).workerPid;
      await first.close();
      const second = await executor.openSession();
      expect(
        JSON.parse(await second.run(request("pid"), { workerEntry })).workerPid,
      ).toBe(pid);
      await second.close();
    } finally {
      await executor.close();
    }
  });

  it("transports one checked epoch and rejects mutated wire metadata", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "zedbee-epoch-")));
    try {
      await writeFile(join(root, "a.js"), "old");
      const capture = (await captureAnalysisSources([
        { snapshotRoot: root, paths: ["a.js", "missing.js"] },
      ]))!;
      const wire = exportAnalysisSourceCapture(capture)!;
      const relativeCanonical = structuredClone(wire);
      const rootEntry = relativeCanonical.roots[0]!.entries[0]!;
      (rootEntry as any).canonicalPath = relative(
        process.cwd(),
        rootEntry.canonicalPath,
      );
      expect(() => importAnalysisSourceCapture(relativeCanonical)).toThrow(
        "Invalid source capture transport",
      );
      const importedWire = structuredClone(wire);
      const imported = importAnalysisSourceCapture(importedWire);
      const originalInode =
        importedWire.roots[0]!.files[0]![1].entry!.lexicalIdentity.inode;
      (
        importedWire.roots[0]!.files[0]![1].entry!.lexicalIdentity as any
      ).inode = originalInode + 1n;
      expect(
        await withAnalysisSourceCapture(
          imported,
          async () =>
            capturedSourceInput(root, "a.js")!.entry!.lexicalIdentity.inode,
        ),
      ).toBe(originalInode);
      await writeFile(join(root, "a.js"), "new");
      const registry = await captureSnapshotRegistry(root);
      expect(
        await withAnalysisSourceCapture(imported, () =>
          readContainedFile(registry, "a.js"),
        ),
      ).toBe("old");
      await capture.close();
      expect(
        await withAnalysisSourceCapture(imported, () =>
          readContainedFile(registry, "a.js"),
        ),
      ).toBe("old");
      const bad = structuredClone(wire) as any;
      bad.roots[0].files[0][1].byteLength = -1;
      expect(() => importAnalysisSourceCapture(bad)).toThrow();
      const duplicate = structuredClone(wire) as any;
      duplicate.roots[0].entries.push(duplicate.roots[0].entries[0]);
      expect(() => importAnalysisSourceCapture(duplicate)).toThrow();
      await imported.close();
      await expect(
        withAnalysisSourceCapture(imported, () =>
          readContainedFile(registry, "a.js"),
        ),
      ).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("stops surviving descendants before session release completes", async () => {
    const root = await mkdtemp(join(tmpdir(), "zedbee-release-tree-"));
    const executor = createLocalAnalyzerExecutor({ concurrency: 1 });
    const session = await executor.openSession();
    try {
      const input = request("pid");
      input.input.source = JSON.stringify({ mode: "surviving-descendant" });
      const pids = JSON.parse(await session.run(input, { workerEntry }));
      await session.close();
      for (const pid of [pids.workerPid, pids.childPid])
        expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      await executor.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
