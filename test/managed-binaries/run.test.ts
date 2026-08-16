import { createHash } from "node:crypto";
import { copyFile, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { runManagedBinary } from "../../src/managed-binaries/run.js";
import type { ManagedBinary } from "../../src/managed-binaries/types.js";

const sha256 = (value: Buffer) =>
  createHash("sha256").update(value).digest("hex");

async function nodeBinary(): Promise<ManagedBinary> {
  const executablePath = await realpath(process.execPath);
  const bytes = await import("node:fs/promises").then(({ readFile }) =>
    readFile(executablePath),
  );
  return {
    engine: "osv-scanner",
    version: "fixture",
    platform: process.platform,
    arch: process.arch,
    packageName: "@zedbee/fixture",
    packageRoot: dirname(executablePath),
    manifestPath: join(dirname(executablePath), "fixture-manifest.json"),
    executablePath,
    executableSha256: sha256(bytes),
  };
}

describe("runManagedBinary", () => {
  it("runs shell-free with ignored stdin and a sanitized environment", async () => {
    const result = await runManagedBinary(
      await nodeBinary(),
      [
        "-e",
        "process.stdout.write(JSON.stringify({secret:process.env.ZEDBEE_TEST_SECRET,stdin:process.stdin.isTTY}))",
      ],
      {
        cwd: process.cwd(),
        timeoutMs: 2_000,
        environment: { ZEDBEE_TEST_SECRET: "must-not-pass" },
      },
    );

    expect(JSON.parse(result.stdout)).toEqual({ stdin: undefined });
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("rejects executable tampering before process creation", async () => {
    const root = await mkdtemp(join(tmpdir(), "zedbee-managed-run-"));
    const executablePath = join(root, "node-copy");
    await copyFile(process.execPath, executablePath);
    const binary = {
      ...(await nodeBinary()),
      packageRoot: root,
      executablePath,
      executableSha256: "0".repeat(64),
    };
    await expect(
      runManagedBinary(binary, ["-e", "throw new Error('must not run')"], {
        cwd: root,
        timeoutMs: 2_000,
      }),
    ).rejects.toMatchObject({ code: "MANAGED_BINARY_CHECKSUM_MISMATCH" });
  });

  it("rechecks managed configuration immediately before process creation", async () => {
    const root = await mkdtemp(join(tmpdir(), "zedbee-managed-config-"));
    const executablePath = join(root, "node-copy");
    const configPath = join(root, "gitleaks.toml");
    await copyFile(process.execPath, executablePath);
    await writeFile(configPath, "safe-config");
    const executable = await import("node:fs/promises").then(({ readFile }) =>
      readFile(executablePath),
    );
    const binary: ManagedBinary = {
      engine: "gitleaks",
      version: "fixture",
      platform: process.platform,
      arch: process.arch,
      packageName: "@zedbee/fixture",
      packageRoot: root,
      manifestPath: join(root, "manifest.json"),
      executablePath,
      executableSha256: sha256(executable),
      configPath,
      configSha256: sha256(Buffer.from("safe-config")),
    };
    await writeFile(configPath, "tampered-config");

    await expect(
      runManagedBinary(binary, ["-e", "throw new Error('must not run')"], {
        cwd: root,
        timeoutMs: 2_000,
      }),
    ).rejects.toMatchObject({ code: "MANAGED_BINARY_CHECKSUM_MISMATCH" });
  });

  it("returns sanitized timeout and cancellation errors", async () => {
    const binary = await nodeBinary();
    await expect(
      runManagedBinary(binary, ["-e", "setInterval(() => {}, 1000)"], {
        cwd: process.cwd(),
        timeoutMs: 25,
      }),
    ).rejects.toMatchObject({ code: "MANAGED_BINARY_TIMEOUT" });

    const controller = new AbortController();
    controller.abort();
    await expect(
      runManagedBinary(binary, ["-e", "setInterval(() => {}, 1000)"], {
        cwd: process.cwd(),
        timeoutMs: 2_000,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "MANAGED_BINARY_ABORTED" });
  });

  it.runIf(process.platform !== "win32")(
    "force-terminates a managed child that refuses graceful cancellation",
    async () => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 20).unref();
      const started = performance.now();

      await expect(
        runManagedBinary(
          await nodeBinary(),
          ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],
          {
            cwd: process.cwd(),
            timeoutMs: 10_000,
            signal: controller.signal,
          },
        ),
      ).rejects.toMatchObject({ code: "MANAGED_BINARY_ABORTED" });
      expect(performance.now() - started).toBeLessThan(3_500);
    },
    5_000,
  );

  it("never includes analyzer output in thrown errors", async () => {
    const canary = "zedbee_secret_error_canary";
    try {
      await runManagedBinary(
        await nodeBinary(),
        [
          "-e",
          `process.stdout.write(${JSON.stringify(canary)});process.stderr.write(${JSON.stringify(canary)});process.exit(7)`,
        ],
        { cwd: process.cwd(), timeoutMs: 2_000 },
      );
      throw new Error("expected managed process failure");
    } catch (error) {
      expect(String(error)).not.toContain(canary);
      expect(JSON.stringify(error)).not.toContain(canary);
      expect(error).toMatchObject({
        code: "MANAGED_BINARY_FAILED",
        exitCode: 7,
      });
    }
  });
});
