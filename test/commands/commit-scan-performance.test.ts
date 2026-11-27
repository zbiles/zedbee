import { expect, it, onTestFinished, vi } from "vitest";
import {
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  rm,
  chmod,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseBenchmarkArguments,
  runCommitScanBenchmark,
} from "../../bench/commit-scan-performance.mjs";
import { createGitRepository } from "../helpers/git-repository.js";

it("rejects incomplete, unknown and unbounded benchmark options", () => {
  for (const args of [
    [],
    ["--samples", "0"],
    ["--samples", "51"],
    ["--unknown", "value"],
  ])
    expect(() => parseBenchmarkArguments(args)).toThrow();
});

it("benchmarks the same staged tree against one parent or all merge parents", async () => {
  const repo = await createGitRepository();
  await repo.write("base.txt", "base");
  await repo.commitAll("base");
  await repo.git(["branch", "incoming"]);
  await repo.write("main.txt", "main");
  await repo.commitAll("main");
  const baseline = (await repo.git(["rev-parse", "HEAD"])).stdout;
  await repo.git(["switch", "incoming"]);
  await repo.write("incoming.txt", "incoming");
  await repo.commitAll("incoming");
  await repo.git(["switch", "main"]);
  const merge = await repo.git(["merge", "--no-edit", "--no-ff", "incoming"]);
  expect(merge.exitCode, merge.stderr).toBe(0);
  const target = (await repo.git(["rev-parse", "HEAD"])).stdout;
  await repo.git(["reset", "--soft", baseline]);
  const scratch = await mkdtemp(join(tmpdir(), "zcb-merge-"));
  onTestFinished(() => rm(scratch, { recursive: true, force: true }));
  const install = join(scratch, "install");
  await mkdir(join(install, "dist"), { recursive: true });
  await writeFile(join(install, "package.json"), '{"version":"0.1.0-fixture"}');
  const cli = join(install, "dist/cli.js");
  await writeFile(
    cli,
    `
    if (process.argv.includes("--help")) console.log("--merge");
    else {
      const incoming = Object.keys(process.env).filter((key) => key.startsWith("GITHEAD_")).map((key) => key.slice(8));
      if (process.argv.includes("--merge") !== (incoming.length > 0)) process.exit(3);
      const mergeParents = incoming.length === 0 ? undefined : ["${baseline}", ...incoming];
      console.log(JSON.stringify({ outcome: "pass", exitCode: 0, checks: [{ status: "completed" }], mergeParents }));
    }
  `,
  );
  vi.stubEnv("GITHEAD_unrelated", "ignored");
  try {
    for (const comparison of ["commit", "merge"] as const) {
      const measurements = await runCommitScanBenchmark({
        cli,
        repository: repo.root,
        baseline,
        target,
        comparison,
        execution: "local",
        cache: "fresh",
        samples: 1,
        output: join(scratch, comparison),
        processSampling: false,
        loadLabel: "idle",
      });
      expect(measurements.parentChangedPathCounts).toEqual(
        comparison === "merge" ? [1, 1] : [1],
      );
      expect(measurements.unionChangedPathCount).toBe(
        comparison === "merge" ? 2 : 1,
      );
      expect(measurements.samples[0]).toMatchObject({
        completedChecks: 1,
        incompleteChecks: 0,
      });
    }
  } finally {
    vi.unstubAllEnvs();
  }
});

it("rejects output inside the measured tree through a parent directory alias", async () => {
  const repo = await createGitRepository();
  await repo.write("package.json", '{"name":"fixture"}');
  await repo.commitAll("baseline");
  const baseline = (await repo.git(["rev-parse", "HEAD"])).stdout;
  const scratch = await mkdtemp(join(tmpdir(), "zcb-alias-"));
  onTestFinished(() => rm(scratch, { recursive: true, force: true }));
  const cliRoot = join(scratch, "install");
  await mkdir(join(cliRoot, "dist"), { recursive: true });
  await writeFile(join(cliRoot, "package.json"), '{"version":"0.1.0-fixture"}');
  const cli = join(cliRoot, "dist/cli.js");
  await writeFile(cli, "console.log('{}');");
  await symlink(
    repo.root,
    join(scratch, "alias"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await expect(
    runCommitScanBenchmark({
      cli,
      repository: repo.root,
      baseline,
      target: baseline,
      execution: "local",
      cache: "fresh",
      samples: 1,
      output: join(scratch, "alias/results"),
      processSampling: false,
      loadLabel: "idle",
    }),
  ).rejects.toThrow("Benchmark output must be outside");
});

it("runs the explicit CLI with isolated state and saves individual canonical reports", async () => {
  const repo = await createGitRepository();
  await repo.write("package.json", '{"name":"fixture"}');
  await repo.write("value.ts", "export const value=1;");
  await repo.commitAll("baseline");
  const baseline = (await repo.git(["rev-parse", "HEAD"])).stdout;
  await repo.write("value.ts", "export const value=2;");
  await repo.commitAll("target");
  const target = (await repo.git(["rev-parse", "HEAD"])).stdout;
  await repo.git(["reset", "--soft", baseline]);
  const cliRoot = join(repo.root, "fixture-install");
  await mkdir(join(cliRoot, "dist"), { recursive: true });
  await writeFile(
    join(cliRoot, "package.json"),
    JSON.stringify({ name: "zedbee", version: "0.1.0-fixture" }),
  );
  const cli = join(cliRoot, "dist/cli.js");
  await writeFile(
    cli,
    `if(process.argv.includes('--help')) console.log('--no-cache'); else if(process.argv.includes('--diagnostic-messages')) process.exit(99); else console.log(JSON.stringify({schemaVersion:1,outcome:'pass',exitCode:0,durationMs:1,checks:[],summary:{passed:0,failed:0,warnings:0,incomplete:0},diagnostics:{scope:'scan-run'}}));`,
  );
  const scratch = await mkdtemp(join(tmpdir(), "zcb-test-"));
  onTestFinished(() => rm(scratch, { recursive: true, force: true }));
  const output = join(scratch, "measurements");
  const args = parseBenchmarkArguments([
    "--cli",
    cli,
    "--repository",
    repo.root,
    "--baseline",
    baseline,
    "--target",
    target,
    "--execution",
    "local",
    "--cache",
    "warm",
    "--samples",
    "2",
    "--output",
    output,
    "--process-sampling",
    "off",
  ]);
  const before = (await repo.git(["diff", "--cached", "--raw"])).stdout;
  const result = await runCommitScanBenchmark(args);
  expect(result.samples).toHaveLength(2);
  expect(result.version).toBe("0.1.0-fixture");
  expect(result.runKind).toBe("commit-scan-performance");
  expect(result.driverPid).toBe(process.pid);
  expect(Date.parse(result.finishedAt)).toBeGreaterThanOrEqual(
    Date.parse(result.startedAt),
  );
  expect(
    result.samples.every(
      (sample) => sample.exitCode === 0 && sample.wallMs > 0,
    ),
  ).toBe(true);
  expect(
    JSON.parse(await readFile(join(output, "sample-1.json"), "utf8")),
  ).toMatchObject({ outcome: "pass" });
  expect((await repo.git(["diff", "--cached", "--raw"])).stdout).toBe(before);
  expect(
    await readFile(join(output, "measurements.json"), "utf8"),
  ).not.toContain("NODE_OPTIONS");
  await expect(runCommitScanBenchmark(args)).rejects.toThrow(/exist/u);
  await writeFile(
    cli,
    `if(process.argv.includes('stop')) process.exit(1); else if(process.argv.includes('--help')) console.log('--no-cache'); else console.log('{}');`,
  );
  await expect(
    runCommitScanBenchmark({
      ...args,
      execution: "service",
      output: join(scratch, "stop-failure"),
    }),
  ).rejects.toThrow("Benchmark service cleanup failed.");

  await writeFile(
    cli,
    `if(process.argv.includes('--help')) console.log('--no-cache'); else console.log(JSON.stringify({outcome:'pass',exitCode:0,durationMs:1,checks:[],summary:{passed:0,failed:0,warnings:0,incomplete:0}}));`,
  );
  if (process.platform !== "win32") {
    const bin = join(scratch, "bin");
    await mkdir(bin);
    await writeFile(join(bin, "ps"), "#!/bin/sh\nexit 0\n");
    await chmod(join(bin, "ps"), 0o755);
    vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
    try {
      const service = await runCommitScanBenchmark({
        ...args,
        execution: "service",
        samples: 1,
        cache: "fresh",
        processSampling: true,
        output: join(scratch, "unknown-service-ownership"),
      });
      expect(service.samples[0]!.processSamplingPartial).toBe(true);
      await writeFile(join(bin, "ps"), "#!/bin/sh\nexit 1\n");
      const unavailable = await runCommitScanBenchmark({
        ...args,
        samples: 1,
        cache: "fresh",
        processSampling: true,
        output: join(scratch, "no-ps"),
      });
      expect(unavailable.samples[0]!.processSamplingPartial).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  }
});

it("accepts measurements only when outcome, reported status and process exit agree", async () => {
  const { validScanVerdict } =
    await import("../../.github/actions/scan/verdict.mjs");
  for (const [outcome, code] of [
    ["pass", 0],
    ["blocked", 1],
    ["incomplete", 2],
  ]) {
    expect(validScanVerdict(outcome, code, code)).toBe(true);
    expect(validScanVerdict(outcome, code, null)).toBe(false);
    expect(validScanVerdict(outcome, undefined, code)).toBe(false);
    expect(validScanVerdict(outcome, code, 3)).toBe(false);
  }
});
