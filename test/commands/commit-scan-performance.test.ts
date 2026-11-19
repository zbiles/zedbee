import { expect, it, onTestFinished, vi } from "vitest";
import {
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  rm,
  chmod,
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
    `if(process.argv.includes('--help')) console.log('--no-cache'); else console.log(JSON.stringify({outcome:'pass',durationMs:1,checks:[],summary:{passed:0,failed:0,warnings:0,incomplete:0}}));`,
  );
  if (process.platform !== "win32") {
    const bin = join(scratch, "bin");
    await mkdir(bin);
    await writeFile(join(bin, "ps"), "#!/bin/sh\nexit 1\n");
    await chmod(join(bin, "ps"), 0o755);
    vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
    try {
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
