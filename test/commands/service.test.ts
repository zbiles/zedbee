import { mkdtemp, readdir, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { expect, it } from "vitest";
import { createGitRepository } from "../helpers/git-repository.js";

const cli = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));

it("manages a default reused CLI service without starting it during read-only status or local scans", async () => {
  const scratch = await realpath(await mkdtemp(join(tmpdir(), "zc-")));
  const repository = await createGitRepository("zedbee-cli-lifecycle-repo-");
  const run = (args: string[]) =>
    execa(process.execPath, [cli, ...args], {
      cwd: repository.root,
      env: {
        TMPDIR: scratch,
        TMP: scratch,
        TEMP: scratch,
        NODE_OPTIONS: "",
        ZEDBEE_UPDATE_CHECK: "0",
      },
      reject: false,
      stdin: "ignore",
    });
  try {
    const absent = await run(["service", "status", "--format", "json"]);
    expect(absent.exitCode, absent.stderr).toBe(0);
    expect(JSON.parse(absent.stdout)).toEqual({ state: "stopped" });
    expect(await readdir(scratch)).toEqual([]);
    await repository.write(
      "package.json",
      '{"name":"lifecycle-fixture","private":true}',
    );
    await repository.write(
      ".zedbeerc.jsonc",
      JSON.stringify({
        schemaVersion: 1,
        profile: "fast",
        checks: {
          lint: "off",
          cyclomaticComplexity: "off",
          readabilityComplexity: "off",
          structuralSecurity: "off",
          reactCorrectness: "off",
          reactAccessibility: "off",
        },
      }),
    );
    await repository.write("a.js", "export const a = 1;\n");
    await repository.commitAll("baseline");
    await repository.write("a.js", "export const a=2\n");
    await repository.git(["add", "--", "a.js"]);
    const local = await run(["scan", "--no-service", "--format", "json"]);
    expect(local.exitCode, local.stderr).toBe(1);
    expect(
      JSON.parse((await run(["service", "status", "--format", "json"])).stdout),
    ).toEqual({ state: "stopped" });
    const first = await run(["scan", "--format", "json"]);
    expect(first.exitCode, first.stderr + first.stdout).toBe(1);
    const before = JSON.parse(
      (await run(["service", "status", "--format", "json"])).stdout,
    );
    expect(before).toMatchObject({ state: "running", activeSessions: 0 });
    const second = await run(["scan", "--format", "json"]);
    expect(second.exitCode, second.stderr).toBe(1);
    const after = JSON.parse(
      (await run(["service", "status", "--format", "json"])).stdout,
    );
    expect(after.pid).toBe(before.pid);
    const fixed = await run(["fix", "formatting", "--yes", "--format", "json"]);
    expect(fixed.exitCode, fixed.stderr).toBe(0);
    expect(await repository.read("a.js")).toBe("export const a = 2;\n");
    expect(
      JSON.parse((await run(["service", "status", "--format", "json"])).stdout)
        .pid,
    ).toBe(before.pid);
    await repository.write(
      "large.js",
      Array.from(
        { length: 30_000 },
        (_, i) => `export const value${i}=${i}`,
      ).join("\n"),
    );
    await repository.git(["add", "--", "large.js"]);
    // Windows SIGTERM is forced termination. Also exercise lost-client recovery
    // on POSIX with SIGKILL, separately from the graceful SIGTERM contract.
    const signals: NodeJS.Signals[] =
      process.platform === "win32" ? ["SIGTERM"] : ["SIGTERM", "SIGKILL"];
    for (const signal of signals) {
      const cancelled = execa(
        process.execPath,
        [cli, "scan", "--format", "json"],
        {
          cwd: repository.root,
          env: {
            TMPDIR: scratch,
            TMP: scratch,
            TEMP: scratch,
            NODE_OPTIONS: "",
            ZEDBEE_NO_UPDATE_CHECK: "1",
          },
          reject: false,
          stdin: "ignore",
          killDescendants: false,
        },
      );
      let completed = false;
      void cancelled.then(() => {
        completed = true;
      });
      let observedActive = false;
      while (!completed) {
        const state = JSON.parse(
          (await run(["service", "status", "--format", "json"])).stdout,
        );
        if (state.activeSessions > 0) {
          observedActive = true;
          expect(cancelled.kill(signal)).toBe(true);
          break;
        }
      }
      const interrupted = await cancelled;
      expect(observedActive).toBe(true);
      const graceful = process.platform !== "win32" && signal === "SIGTERM";
      if (graceful) {
        expect(interrupted.exitCode, interrupted.stderr).toBe(143);
      } else {
        // Execa preserves Node's native result; Windows does not run the CLI's
        // JavaScript handler and need not report the POSIX normal exit code 143.
        const native = cancelled.nodeChildProcess;
        expect(interrupted.failed).toBe(true);
        expect(interrupted.exitCode).toBe(native.exitCode ?? undefined);
        expect(interrupted.signal).toBe(native.signalCode ?? undefined);
        expect(
          native.signalCode !== null ||
            (native.exitCode !== null && native.exitCode !== 0),
        ).toBe(true);
      }
      // A killed client is not proof of service cleanup. Observe the same live
      // service until its sessions drain. The whole-run supervisor bounds this
      // recovery wait, just like the active-session wait above; no per-test timer.
      for (;;) {
        const status = await run(["service", "status", "--format", "json"]);
        expect(status.exitCode, status.stderr).toBe(0);
        const state = JSON.parse(status.stdout);
        expect(state).toMatchObject({ state: "running", pid: before.pid });
        expect(state.activeSessions).toBeGreaterThanOrEqual(0);
        if (graceful || state.activeSessions === 0) {
          expect(state.activeSessions).toBe(0);
          break;
        }
      }
    }
    const stopped = await run(["service", "stop", "--format", "json"]);
    expect(stopped.exitCode, stopped.stderr).toBe(0);
    expect(JSON.parse(stopped.stdout)).toEqual({ state: "stopped" });
    expect(
      JSON.parse((await run(["service", "status", "--format", "json"])).stdout),
    ).toEqual({ state: "stopped" });
  } finally {
    const stopped = await run(["service", "stop", "--format", "json"]);
    if (stopped.exitCode === 0) await rm(scratch, { recursive: true });
  }
});
