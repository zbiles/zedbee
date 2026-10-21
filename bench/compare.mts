import { execFileSync, spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

type Measurement = { coldMs: number; warmMs: number };
type Fixtures = Record<string, Record<string, Measurement>>;
type Report = {
  schemaVersion: number;
  kind: string;
  environment?: Record<string, unknown> | undefined;
  fixtures: Fixtures;
};

export interface PerformanceComparison {
  schemaVersion: 1;
  kind: "same-job-base-head-phase-comparison";
  status: "passed" | "regression" | "unavailable";
  baseCommit: unknown;
  headCommit: unknown;
  comparedMetrics: number;
  regressions: Array<{
    fixture: string;
    phase: string;
    metric: "coldMs" | "warmMs";
    baseMs: number;
    headMs: number;
  }>;
  unavailable: string[];
  limitations: string;
}

function measurements(input: unknown): Report {
  const report = input as Report | null;
  if (
    !report ||
    report.schemaVersion !== 1 ||
    !report.fixtures ||
    typeof report.fixtures !== "object"
  )
    throw new Error("Invalid benchmark measurement report.");
  for (const phases of Object.values(report.fixtures)) {
    if (!phases || typeof phases !== "object")
      throw new Error("Invalid benchmark measurements.");
    for (const timing of Object.values(phases)) {
      if (
        !timing ||
        ![timing.coldMs, timing.warmMs].every(
          (value) =>
            typeof value === "number" && Number.isFinite(value) && value >= 0,
        )
      )
        throw new Error(
          "Invalid benchmark measurement: timings must be finite nonnegative numbers.",
        );
    }
  }
  return report;
}

export function compareBenchmarkReports(
  baseInput: unknown,
  headInput: unknown,
): PerformanceComparison {
  const base = measurements(baseInput);
  const head = measurements(headInput);
  const result: PerformanceComparison = {
    schemaVersion: 1,
    kind: "same-job-base-head-phase-comparison",
    status: "unavailable",
    baseCommit: base.environment?.commit ?? null,
    headCommit: head.environment?.commit ?? null,
    comparedMetrics: 0,
    regressions: [],
    unavailable: [],
    limitations:
      "Only common phases from the same measurement method are compared. Added and removed phases have no comparison. Phase medians are not end-to-end CLI timings; runner load and harness changes can affect results. Threshold: more than 25% AND more than 250 ms slower.",
  };
  const unavailable = (reason: string) => {
    result.unavailable.push(reason);
    return result;
  };
  if (!base.environment || !head.environment)
    return unavailable("Environment provenance is missing.");
  if (
    !result.baseCommit ||
    !result.headCommit ||
    result.baseCommit === result.headCommit
  )
    return unavailable("Distinct base and head source commits are required.");
  if (
    base.kind !== "within-session-phase-comparison" ||
    head.kind !== base.kind
  )
    return unavailable("Measurement methods differ or are not recognized.");
  for (const key of [
    "node",
    "platform",
    "architecture",
    "osRelease",
    "osVersion",
    "cpuModels",
    "logicalCpus",
    "memoryBytes",
    "githubActions",
  ]) {
    if (
      base.environment[key] === undefined ||
      JSON.stringify(base.environment[key]) !==
        JSON.stringify(head.environment[key])
    )
      return unavailable(`Environment mismatch or missing field: ${key}.`);
  }
  const fixtures = new Set([
    ...Object.keys(base.fixtures),
    ...Object.keys(head.fixtures),
  ]);
  for (const fixture of fixtures) {
    const before = base.fixtures[fixture] ?? {};
    const after = head.fixtures[fixture] ?? {};
    for (const phase of new Set([
      ...Object.keys(before),
      ...Object.keys(after),
    ])) {
      if (!Object.hasOwn(before, phase) || !Object.hasOwn(after, phase)) {
        result.unavailable.push(
          `${fixture}/${phase}: absent from ${Object.hasOwn(before, phase) ? "head" : "base"}`,
        );
        continue;
      }
      for (const metric of ["coldMs", "warmMs"] as const) {
        const baseMs = before[phase]![metric];
        const headMs = after[phase]![metric];
        result.comparedMetrics += 1;
        if (headMs > baseMs * 1.25 && headMs - baseMs > 250)
          result.regressions.push({ fixture, phase, metric, baseMs, headMs });
      }
    }
  }
  if (!result.comparedMetrics)
    return unavailable(
      "No common measured phases; no regression comparison passed.",
    );
  result.status = result.regressions.length ? "regression" : "passed";
  return result;
}

export function selectPerformanceBase(repository: string): string {
  const git = (...args: string[]): string =>
    execFileSync("git", args, {
      cwd: repository,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  let parent: string;
  try {
    parent = git("rev-parse", "--verify", "HEAD^1");
  } catch {
    throw new Error(
      "Performance comparison unavailable: HEAD has no parent commit.",
    );
  }
  try {
    const tag = git(
      "describe",
      "--tags",
      "--match",
      "v*",
      "--abbrev=0",
      parent,
    );
    return git("rev-parse", "--verify", `${tag}^{commit}`);
  } catch {
    return parent;
  }
}

async function main() {
  if (process.argv.includes("--select-base")) {
    process.stdout.write(`${selectPerformanceBase(process.cwd())}\n`);
    return;
  }
  const argument = (name: string) => {
    const index = process.argv.indexOf(name);
    if (
      index < 0 ||
      !process.argv[index + 1] ||
      process.argv[index + 1]!.startsWith("--")
    )
      throw new Error(`Required argument: ${name} <path>.`);
    return resolve(process.argv[index + 1]!);
  };
  const baseRoot = argument("--base-root");
  const output = argument("--output");
  const headRoot = process.cwd();
  if (baseRoot === headRoot)
    throw new Error("Base and head checkouts must differ.");
  const measure = async (root: string, label: string): Promise<unknown> => {
    const child = spawnSync(
      process.execPath,
      ["--experimental-strip-types", "bench/run.mts"],
      {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "inherit"],
        maxBuffer: 16 * 1024 * 1024,
        env: {
          ...process.env,
          ZEDBEE_TELEMETRY_DISABLED: "1",
          ZEDBEE_BENCHMARK_MODE: "smoke",
        },
      },
    );
    if (child.error || child.status !== 0)
      throw new Error(`${label} benchmark measurement failed.`, {
        cause: child.error,
      });
    const parsed: unknown = JSON.parse(child.stdout);
    await writeFile(
      `${output}.${label}.json`,
      `${JSON.stringify(parsed, null, 2)}\n`,
    );
    return parsed;
  };
  // Sequential runs share this runner and Node process executable; each revision
  // uses its own dependencies and benchmark harness. Neither writes history.
  let comparison: PerformanceComparison;
  try {
    const base = await measure(baseRoot, "base");
    const head = await measure(headRoot, "head");
    comparison = compareBenchmarkReports(base, head);
  } catch (error) {
    comparison = {
      schemaVersion: 1,
      kind: "same-job-base-head-phase-comparison",
      status: "unavailable",
      baseCommit: null,
      headCommit: null,
      comparedMetrics: 0,
      regressions: [],
      unavailable: [
        error instanceof Error
          ? error.message
          : "Benchmark measurement failed.",
      ],
      limitations:
        "No regression comparison passed. See the measurement logs and retained reports.",
    };
  }
  await writeFile(output, `${JSON.stringify(comparison, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(comparison, null, 2)}\n`);
  if (comparison.status !== "passed")
    throw new Error(`Performance gate ${comparison.status}; see ${output}.`);
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Performance gate failed."}\n`,
    );
    process.exitCode = 1;
  }
}
