import { mkdtemp, readdir, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { expect, it } from "vitest";
import { connectService } from "../../dist/service/client.js";
import { serviceLocation } from "../../dist/service/identity.js";
import { ServiceState } from "../../dist/service/state.js";
import { createGitRepository } from "../helpers/git-repository.js";

const cli = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));

it("manages a default reused CLI service without starting it during read-only status or local scans", async () => {
  const scratch = await realpath(await mkdtemp(join(tmpdir(), "zc-")));
  const repository = await createGitRepository("zedbee-cli-lifecycle-repo-");
  let observer: Awaited<ReturnType<typeof connectService>> | undefined;
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
    // Keep an authenticated status connection open so starting a fresh CLI
    // process cannot hide the entire session between observations on Windows.
    const location = await serviceLocation();
    const state = new ServiceState(
      join(scratch, `zedbee-${location.key.slice(0, 24)}`),
    );
    const record = await state.read();
    expect(record).toBeDefined();
    observer = await connectService(state, record!);
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
        const state = (await observer.request("status")) as {
          activeSessions: number;
        };
        if (state.activeSessions > 0) {
          observedActive = true;
          expect(cancelled.kill(signal)).toBe(true);
          break;
        }
      }
      const interrupted = await cancelled;
      expect(observedActive, interrupted.stdout + interrupted.stderr).toBe(true);
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
    await observer?.close();
    const stopped = await run(["service", "stop", "--format", "json"]);
    if (stopped.exitCode === 0) await rm(scratch, { recursive: true });
  }
});

it("preserves every structural parse failure through local and service hook scans", async () => {
  const scratch = await realpath(await mkdtemp(join(tmpdir(), "zc-")));
  const repository = await createGitRepository();
  const run = (args: string[]) =>
    execa(process.execPath, [cli, ...args], {
      cwd: repository.root,
      env: {
        TMPDIR: scratch,
        TMP: scratch,
        TEMP: scratch,
        ZEDBEE_TELEMETRY_DISABLED: "1",
      },
      reject: false,
      stdin: "ignore",
    });
  const configure = (failOnIncomplete: boolean) =>
    repository.write(
      ".zedbeerc.jsonc",
      JSON.stringify({
        schemaVersion: 1,
        profile: "fast",
        failOnIncomplete,
        checks: {
          structuralSecurity: "error",
          lint: "off",
          formatting: "off",
          cyclomaticComplexity: "off",
          readabilityComplexity: "off",
          reactCorrectness: "off",
          reactAccessibility: "off",
        },
      }),
    );
  try {
    await repository.write(
      "package.json",
      '{"name":"parse-fixture","private":true}',
    );
    await configure(true);
    await repository.commitAll("baseline");
    await repository.write(
      "a.ts",
      "export function flag() {\n  const using = true;\n  return using;\n}",
    );
    await repository.write(
      "b.tsx",
      "const [using, setUsing] = useState(false);",
    );
    await repository.git(["add", "--", "a.ts", "b.tsx"]);
    const scan = (...args: string[]) =>
      run(["scan", "--hook-invocation", "--format", "json", ...args]);
    const safe = await scan("--no-service");
    expect(safe.exitCode, safe.stdout + safe.stderr).toBe(0);

    await repository.write("a.ts", "eval(input);");
    await repository.git(["add", "--", "a.ts"]);
    expect((await scan("--no-service")).exitCode).toBe(1);

    await repository.write("a.ts", 'const label = "🐝";\r\nconst value = ;');
    await repository.write("b.tsx", 'export type * as example from "fixture";');
    await repository.write("c.ts", "function broken() {\n");
    await repository.git(["add", "--", "a.ts", "b.tsx", "c.ts"]);
    const local = await scan("--no-service");
    const service = await scan();
    expect(local.exitCode, local.stderr).toBe(2);
    expect(service.exitCode, service.stderr).toBe(2);
    const structural = (stdout: string) =>
      JSON.parse(stdout).checks.find(
        (check: { checkId: string }) => check.checkId === "structuralSecurity",
      );
    expect(
      structural(service.stdout),
      service.stdout + service.stderr,
    ).toBeDefined();
    const error = structural(service.stdout).error;
    expect(error).toStrictEqual(structural(local.stdout).error);
    expect(error.parseFailures).toEqual({
      files: [
        {
          path: "a.ts",
          snapshot: "staged",
          line: 2,
          column: 15,
          typescriptCode: 1109,
          reason: "Expression expected.",
        },
        {
          path: "b.tsx",
          snapshot: "staged",
          line: 1,
          column: 8,
          reason: "The structural parser could not recognize this syntax.",
        },
        {
          path: "c.ts",
          snapshot: "staged",
          line: 2,
          column: 1,
          typescriptCode: 1005,
          expectedToken: "}",
          reason: "'}' expected.",
        },
      ],
      omitted: 0,
    });
    expect(
      JSON.parse((await run(["service", "status", "--format", "json"])).stdout)
        .state,
    ).toBe("running");
    const text = await run([
      "scan",
      "--hook-invocation",
      "--format",
      "text",
      "--no-color",
    ]);
    expect(text.exitCode).toBe(2);
    expect(text.stdout).toContain("a.ts:2:15");
    expect(text.stdout).toContain("b.tsx:1:8");
    await configure(false);
    await repository.git(["add", "--", ".zedbeerc.jsonc"]);
    const warned = await scan();
    expect(warned.exitCode, warned.stdout + warned.stderr).toBe(0);
    expect(structural(warned.stdout)).toMatchObject({
      status: "incomplete",
      incompleteDisposition: "warn",
      error: { parseFailures: error.parseFailures },
    });
  } finally {
    const stopped = await run(["service", "stop", "--format", "json"]);
    if (stopped.exitCode === 0) await rm(scratch, { recursive: true });
  }
});
