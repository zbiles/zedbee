import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { cpus, release, totalmem, version } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface Baselines {
  schemaVersion: 1;
  provenance?: string;
  environment?: ReturnType<typeof captureEnvironment>;
  fixtures: Record<string, Record<string, { coldMs: number; warmMs: number }>>;
}

export function captureEnvironment(
  repository: string,
  env: NodeJS.ProcessEnv = process.env,
) {
  const git = (...args: string[]): string | null => {
    try {
      return execFileSync("git", args, {
        cwd: repository,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      return null;
    }
  };
  const status = git("status", "--porcelain", "--untracked-files=normal");
  const processors = cpus();
  // Record only benchmark context, never the whole environment or a hostname.
  return {
    capturedAt: new Date().toISOString(),
    commit: git("rev-parse", "HEAD"),
    workingTreeDirty: status === null ? null : status.length > 0,
    node: process.version,
    platform: process.platform,
    architecture: process.arch,
    osRelease: release(),
    osVersion: version(),
    cpuModels: [...new Set(processors.map((cpu) => cpu.model))],
    logicalCpus: processors.length,
    memoryBytes: totalmem(),
    githubActions:
      env.GITHUB_ACTIONS === "true"
        ? {
            runUrl:
              env.GITHUB_SERVER_URL &&
              env.GITHUB_REPOSITORY &&
              env.GITHUB_RUN_ID
                ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}${env.GITHUB_RUN_ATTEMPT ? `/attempts/${env.GITHUB_RUN_ATTEMPT}` : ""}`
                : null,
            job: env.GITHUB_JOB ?? null,
            runnerEnvironment: env.RUNNER_ENVIRONMENT ?? null,
            runnerLabel: env.ZEDBEE_BENCHMARK_RUNNER ?? null,
            image: env.ImageOS ?? null,
            imageVersion: env.ImageVersion ?? null,
          }
        : null,
  };
}

export const phaseLimitations =
  "Repeated phase samples share one fixture-scoped analysis session; final session cleanup is outside phase timings. " +
  "These are not complete CLI timings. coldMs/warmMs are historical field names, not fresh/warm process guarantees. " +
  "Historical Secretlint and OSV substitutions remain; the snapshot phase measures cache-key hashing, not Git materialization.";

function cell(value: string | number | null | undefined): string {
  return String(value ?? "Not recorded")
    .replaceAll("|", "\\|")
    .replace(/[\r\n]+/g, " ");
}

function phaseLabel(name: string): string {
  if (name === "snapshot") return "Snapshot cache-key hashing";
  const words = name
    .replace(/^adapter\./, "")
    .replace(/\.execute$/, "")
    .replace(/\.collect$/, " (collection)")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function renderBaselineReport(baseline: Baselines): string {
  const environment = baseline.environment;
  const actions = environment?.githubActions;
  const details: [string, string | number | null | undefined][] = [
    [
      "Origin",
      baseline.provenance ??
        (environment ? (actions ? "GitHub Actions" : "Local run") : undefined),
    ],
    ["Measured at (UTC)", environment?.capturedAt],
    ["Source commit", environment?.commit],
    [
      "Uncommitted changes",
      environment?.workingTreeDirty == null
        ? null
        : environment.workingTreeDirty
          ? "Yes"
          : "No",
    ],
    ["Node.js", environment?.node],
    [
      "Platform / architecture",
      environment
        ? `${environment.platform} / ${environment.architecture}`
        : null,
    ],
    [
      "OS version / release",
      environment
        ? `${environment.osVersion} / ${environment.osRelease}`
        : null,
    ],
    ["CPU", environment?.cpuModels.join(", ") || null],
    ["Logical CPUs", environment?.logicalCpus],
    [
      "Memory visible to process (GiB)",
      environment ? (environment.memoryBytes / 1024 ** 3).toFixed(2) : null,
    ],
  ];
  if (actions)
    details.push(
      ["Actions run", actions.runUrl],
      ["Actions job", actions.job],
      ["Runner type", actions.runnerEnvironment],
      ["Runner label", actions.runnerLabel],
      ["Runner image", actions.image],
      ["Runner image version", actions.imageVersion],
    );
  const lines = [
    "# Zedbee benchmark baselines",
    "",
    "Recorded phase timings for development regression checks. Actual scan times depend on the project, enabled checks, and execution environment.",
    "",
    "This report is generated from [baselines.json](baselines.json). The JSON retains full precision for automated comparisons; tables round milliseconds to two decimal places.",
    "",
    "## Measurement environment",
    "",
    "| Detail | Recorded value |",
    "| --- | --- |",
    ...details.map(([label, value]) => `| ${label} | ${cell(value)} |`),
    "",
    "CPU and memory describe what the process could see, including virtual hardware on hosted runners. Runner labels such as `ubuntu-latest` can change over time; use the recorded image version and run link when available.",
    "",
    "## Results",
    "",
    "Each value is a median: the first batch has three samples and the second has five. The column names describe sample order; they do not mean a fresh process followed by a warmed process.",
    "",
  ];
  for (const [fixture, phases] of Object.entries(baseline.fixtures)) {
    lines.push(
      `### ${cell(fixture)} fixture`,
      "",
      "| Phase | First batch (ms) | Subsequent batch (ms) |",
      "| --- | ---: | ---: |",
      ...Object.entries(phases).map(
        ([name, value]) =>
          `| ${cell(phaseLabel(name))} | ${value.coldMs.toFixed(2)} | ${value.warmMs.toFixed(2)} |`,
      ),
      "",
    );
  }
  lines.push(
    "## Current benchmark method and limitations",
    "",
    phaseLimitations,
    "",
    "The source revision matters as well as the machine: the harness and analyzer implementations can change between releases. The historical baseline predates environment capture; its presence in an old commit does not identify the exact revision used to measure it.",
    "",
    "The small fixture exercises individual analyzers. The monorepo fixture contains a root workspace and 12 package workspaces, and measures the supporting phases listed above.",
    "",
    "The existing comparison fails only when a phase is both more than 25% slower and more than 250 ms slower than its baseline. A failure across different machines or runtimes does not, by itself, establish a code regression. Compare revisions under the same conditions when investigating one.",
    "",
    "## Reproduce or update",
    "",
    "From a repository checkout with its supported Node.js version:",
    "",
    "```sh",
    "npm ci --ignore-scripts",
    "npm run benchmark",
    "```",
    "",
    "To deliberately replace the baseline with new measurements and their environment:",
    "",
    "```sh",
    "npm run benchmark:update",
    "```",
    "",
    "That command updates both `bench/baselines.json` and this report. Review and commit them together. Keep the machine otherwise idle and record whether a VM was used in the review. GitHub Actions runs also record the job, runner image, and run link when available.",
    "",
    "To regenerate only this readable report without measuring or changing the baseline:",
    "",
    "```sh",
    "npm run benchmark:report",
    "```",
    "",
  );
  return lines.join("\n");
}

export async function writeBaselineFiles(
  directory: string,
  baseline: Baselines,
): Promise<void> {
  await writeFile(
    join(directory, "baselines.json"),
    `${JSON.stringify(baseline, null, 2)}\n`,
  );
  await writeFile(join(directory, "README.md"), renderBaselineReport(baseline));
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const directory = dirname(fileURLToPath(import.meta.url));
  const baseline = JSON.parse(
    await readFile(join(directory, "baselines.json"), "utf8"),
  ) as Baselines;
  await writeFile(join(directory, "README.md"), renderBaselineReport(baseline));
  process.stdout.write("Benchmark report updated; measurements unchanged.\n");
}
