import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { runAnalyzerJob } from "../../../src/checks/runner/run-job.js";
import { AnalyzerJobError } from "../../../src/checks/diagnostics.js";
import { DEFAULT_FORMATTING_SETTINGS } from "../../../src/checks/prettier/settings.js";

const workerEntry = fileURLToPath(
  new URL("./fixtures/worker.mjs", import.meta.url),
);
const scratch: string[] = [];
afterEach(async () => {
  await Promise.all(
    scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
const request = (source: string) => ({
  version: 1 as const,
  checkId: "formatting" as const,
  operation: "format-working-source" as const,
  input: { file: "a.js", source, settings: DEFAULT_FORMATTING_SETTINGS },
});
const fixture = (mode: string, extra = {}) =>
  request(JSON.stringify({ mode, ...extra }));
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("managed analyzer runner", () => {
  it("supervisor loss stops the blocked tree before the runner settles", async () => {
    const root = await mkdtemp(join(tmpdir(), "zedbee-supervisor-loss-"));
    scratch.push(root);
    const path = join(root, "pids.json");
    const result = runAnalyzerJob(
      fixture(process.platform === "win32" ? "blocked-detached" : "blocked", {
        path,
      }),
      {
        workerEntry,
      },
    ).catch((error) => error);
    await expect.poll(() => existsSync(path), { timeout: 10000 }).toBe(true);
    const pids = JSON.parse(await readFile(path, "utf8"));
    try {
      expect(alive(pids.workerPid)).toBe(true);
      expect(alive(pids.childPid)).toBe(true);
      if (process.platform === "win32") {
        const { default: koffi } = await import("koffi");
        const kernel = koffi.load("kernel32.dll");
        const open = kernel.func(
          "void * __stdcall OpenProcess(uint32_t access, int inherit, uint32_t pid)",
        );
        const terminate = kernel.func(
          "int __stdcall TerminateProcess(void *process, uint32_t exitCode)",
        );
        const close = kernel.func("int __stdcall CloseHandle(void *handle)");
        const handle = open(1, 0, pids.supervisorPid);
        expect(handle).toBeTruthy();
        try {
          expect(terminate(handle, 7)).toBe(1);
        } finally {
          close(handle);
        }
      } else process.kill(pids.supervisorPid, "SIGKILL");
      expect((await result).diagnostic.category).toBe("abnormal-exit");
      expect(alive(pids.workerPid)).toBe(false);
      expect(alive(pids.childPid)).toBe(false);
    } finally {
      for (const pid of [pids.workerPid, pids.childPid]) {
        if (alive(pid)) process.kill(pid, "SIGKILL");
      }
    }
  });
  it("uses a fresh real worker instead of the caller", async () => {
    const result = await runAnalyzerJob(fixture("pid"), { workerEntry });
    expect(JSON.parse(result).workerPid).not.toBe(process.pid);
  });
  it.each(["missing", "invalid"])(
    "rejects %s output as incomplete",
    async (mode) => {
      const failure = await runAnalyzerJob(fixture(mode), {
        workerEntry,
      }).catch((error) => error);
      expect(failure).toBeInstanceOf(AnalyzerJobError);
      expect(failure.diagnostic.category).toBe("invalid-response");
      expect(JSON.stringify(failure)).not.toContain("fixture-secret-marker");
    },
  );
  it("retains a safe abnormal exit status without raw stderr", async () => {
    const failure = await runAnalyzerJob(fixture("crash"), {
      workerEntry,
    }).catch((error) => error);
    expect(failure.diagnostic).toMatchObject({
      category: "abnormal-exit",
      exitCode: 7,
    });
    expect(JSON.stringify(failure)).not.toContain("fixture-secret-marker");
  });
  it.each([
    ["reply-then-crash", 7],
    ["reply-then-exit-one", 1],
  ] as const)(
    "does not accept %s followed by worker exit %s",
    async (mode, exitCode) => {
      await expect(
        runAnalyzerJob(fixture(mode), { workerEntry }),
      ).rejects.toMatchObject({
        diagnostic: { category: "abnormal-exit", exitCode },
      });
    },
  );
  it("waits for surviving descendants after an abnormal worker exit", async () => {
    const root = await mkdtemp(join(tmpdir(), "zedbee-crash-tree-"));
    scratch.push(root);
    const path = join(root, "pids.json");
    await expect(
      runAnalyzerJob(fixture("crash-descendant", { path }), { workerEntry }),
    ).rejects.toMatchObject({
      diagnostic: { category: "abnormal-exit", exitCode: 7 },
    });
    const pids = JSON.parse(await readFile(path, "utf8"));
    expect(alive(pids.workerPid)).toBe(false);
    expect(alive(pids.childPid)).toBe(false);
  });
  it.skipIf(process.platform === "win32")(
    "does not accept a reply followed by an unrequested worker signal",
    async () => {
      await expect(
        runAnalyzerJob(fixture("reply-then-signal"), { workerEntry }),
      ).rejects.toMatchObject({
        diagnostic: { category: "abnormal-exit", signal: "SIGTERM" },
      });
    },
  );
  it("rejects unknown checks and invalid operations before startup", async () => {
    await expect(
      runAnalyzerJob({
        ...fixture("pid"),
        checkId: "fixture-secret-marker",
      } as never),
    ).rejects.toThrow();
    await expect(
      runAnalyzerJob({ ...fixture("pid"), operation: "import" } as never),
    ).rejects.toThrow();
  });
  it("reports worker startup/import failure without an in-process fallback", async () => {
    const error = await runAnalyzerJob(request("const x=1"), {
      workerEntry: join(tmpdir(), "zedbee-worker-does-not-exist.mjs"),
    }).catch((error) => error);
    expect(error).toBeInstanceOf(AnalyzerJobError);
    expect(error.diagnostic.category).toBe("startup");
  });
  it("keeps the parent responsive and waits for blocked worker descendants to stop on cancellation", async () => {
    const root = await mkdtemp(join(tmpdir(), "zedbee-runner-test-"));
    scratch.push(root);
    const path = join(root, "pids.json");
    const controller = new AbortController();
    const result = runAnalyzerJob(fixture("blocked", { path }), {
      workerEntry,
      signal: controller.signal,
    }).catch((error) => error);
    let pids: { workerPid: number; childPid: number } | undefined;
    try {
      await expect
        .poll(
          async () => {
            try {
              pids = JSON.parse(await readFile(path, "utf8"));
              return true;
            } catch {
              return false;
            }
          },
          { timeout: 10000 },
        )
        .toBe(true);
      let timerRan = false;
      await new Promise<void>((resolve) =>
        setTimeout(() => {
          timerRan = true;
          resolve();
        }, 20),
      );
      expect(timerRan).toBe(true);
    } finally {
      controller.abort();
    }
    const error = await result;
    expect(error.diagnostic.category).toBe("cancellation");
    expect(alive(pids!.workerPid)).toBe(false);
    await expect
      .poll(() => alive(pids!.childPid), { timeout: 5000 })
      .toBe(false);
  });
  it("does not launch an already cancelled job", async () => {
    await expect(
      runAnalyzerJob(fixture("pid"), {
        workerEntry,
        signal: AbortSignal.abort(),
      }),
    ).rejects.toMatchObject({ diagnostic: { category: "cancellation" } });
  });
  it.each(["SIGKILL", "SIGINT"] as const)(
    "caller loss via %s stops a synchronously blocked worker and its descendant",
    async (signal) => {
      const root = await mkdtemp(join(tmpdir(), "zedbee-parent-loss-"));
      scratch.push(root);
      const path = join(root, "pids.json");
      const parentEntry = fileURLToPath(
        new URL("./fixtures/parent.mjs", import.meta.url),
      );
      const parent = spawn(
        process.execPath,
        [
          "--import",
          import.meta.resolve("tsx"),
          parentEntry,
          workerEntry,
          path,
        ],
        { stdio: "ignore", detached: process.platform !== "win32" },
      );
      let pids: { workerPid: number; childPid: number } | undefined;
      try {
        await expect
          .poll(
            async () => {
              try {
                pids = JSON.parse(await readFile(path, "utf8"));
                return true;
              } catch {
                return false;
              }
            },
            { timeout: 10000 },
          )
          .toBe(true);
      } finally {
        const closed = once(parent, "close");
        if (signal === "SIGINT" && process.platform !== "win32")
          process.kill(-parent.pid!, signal);
        else parent.kill("SIGKILL");
        await closed;
      }
      try {
        await expect
          .poll(() => alive(pids!.workerPid) || alive(pids!.childPid), {
            timeout: 10000,
          })
          .toBe(false);
      } finally {
        if (process.platform !== "win32" && pids && alive(pids.workerPid)) {
          try {
            process.kill(-pids.workerPid, "SIGKILL");
          } catch {}
        }
      }
    },
  );

  it("runs the real installed worker entry and formats source", async () => {
    expect(await runAnalyzerJob(request("const x=1"))).toBe("const x = 1;\n");
  });
  it("caps shared jobs at two and cancels queued work before child startup", async () => {
    const root = await mkdtemp(join(tmpdir(), "zedbee-runner-queue-"));
    scratch.push(root);
    const release = join(root, "release");
    const controller = new AbortController();
    const paths = [0, 1, 2].map((id) => join(root, `${id}.pid`));
    const jobs = paths.map((path, index) =>
      runAnalyzerJob(fixture("gate", { path, release }), {
        workerEntry,
        ...(index === 2 ? { signal: controller.signal } : {}),
      }).catch((error) => error),
    );
    try {
      await expect
        .poll(() => paths.slice(0, 2).every(existsSync), { timeout: 10000 })
        .toBe(true);
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      expect(existsSync(paths[2]!)).toBe(false);
      controller.abort();
    } finally {
      await writeFile(release, "release");
      await Promise.all(jobs);
    }
    const outcomes = await Promise.all(jobs);
    expect(outcomes[2]).toMatchObject({
      diagnostic: { category: "cancellation" },
    });
    expect(existsSync(paths[2]!)).toBe(false);
  });
});
