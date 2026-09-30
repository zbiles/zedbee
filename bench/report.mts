import { execFileSync } from "node:child_process";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { cpus, release, totalmem, version } from "node:os";
import { join } from "node:path";

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
    machine: env.ZEDBEE_BENCHMARK_MACHINE ?? null,
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

const phaseLabels: Record<string, string> = {
  snapshot: "Snapshot cache-key hashing",
  inspection: "Inspection",
  "adapter.structuralSecurity.collect": "Structural security (collection)",
  attribution: "Attribution",
  rendering: "Rendering",
  "adapter.formatting.execute": "Formatting",
  "adapter.lint.execute": "Lint",
  "adapter.types.execute": "Types",
  "adapter.cyclomaticComplexity.execute": "Cyclomatic complexity",
  "adapter.readabilityComplexity.execute": "Readability complexity",
  "adapter.structuralSecurity.execute": "Structural security",
  "adapter.secrets.execute": "Secrets",
  "adapter.duplication.execute": "Duplication",
  "adapter.dependencyArchitecture.execute": "Dependency architecture",
  "adapter.deadCode.execute": "Dead code",
  "adapter.reactCorrectness.execute": "React correctness",
  "adapter.reactAccessibility.execute": "React accessibility",
  "adapter.vulnerabilities.execute": "Vulnerabilities",
};

function phaseLabel(name: string): string {
  if (!Object.hasOwn(phaseLabels, name))
    throw new Error(`Unknown benchmark phase: ${name}`);
  return phaseLabels[name]!;
}

function environmentDetails(baseline: Baselines) {
  const environment = baseline.environment;
  const actions = environment?.githubActions;
  const details: [string, string | number | null | undefined][] = [
    [
      "Origin",
      baseline.provenance ??
        (environment ? (actions ? "GitHub Actions" : "Local run") : undefined),
    ],
    ["Measured at (UTC)", environment?.capturedAt],
    ...(environment?.machine
      ? [["Machine", environment.machine] as [string, string]]
      : []),
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
  return details;
}

export interface BenchmarkRun {
  title: string;
  details: Record<string, string>;
  fixtures: Baselines["fixtures"];
}

const matchingFields = [
  "Origin",
  "Node.js",
  "Platform / architecture",
  "OS version / release",
  "CPU",
  "Logical CPUs",
  "Memory visible to process (GiB)",
  "Runner type",
  "Runner label",
  "Runner image",
  "Runner image version",
];

function matchingRun(
  runs: BenchmarkRun[],
  environment: NonNullable<Baselines["environment"]>,
) {
  const current = Object.fromEntries(
    environmentDetails({ schemaVersion: 1, environment, fixtures: {} }).map(
      ([key, value]) => [key, cell(value)],
    ),
  );
  return runs.findLast((run) =>
    matchingFields.every((key) => {
      const expected = current[key];
      return expected === undefined
        ? run.details[key] === undefined
        : expected !== "Not recorded" && run.details[key] === expected;
    }),
  );
}

export function selectBaseline(
  runs: BenchmarkRun[],
  environment: NonNullable<Baselines["environment"]>,
): BenchmarkRun {
  const match = matchingRun(runs, environment);
  if (!match)
    throw new Error(
      "No benchmark run with a matching environment. Use npm run benchmark:update to append an initial run for this environment; no regression comparison has passed.",
    );
  return match;
}

const historyIntroduction = `# Zedbee benchmark history

This is the single record of benchmark results and the environments that produced them. Runs are retained in chronological order; updates append a dated entry instead of replacing earlier measurements.

## Reading changes over time

Each run has its own machine details and timing tables. A change table compares it with the previous entry having matching CPU, memory, OS, architecture, Node version, and hosted-runner details. Positive changes mean slower; negative changes mean faster. Different environments are separate series, so the original GitHub run and the Mac run are not evidence of a code speedup or slowdown.

The original GitHub measurements have an unrecorded date and incomplete environment information. They remain visible as historical results and are not used for automatic regression comparisons.

## Run and record

Run \`npm run benchmark\` to compare against the latest entry with a matching recorded environment. With no matching entry, the command reports that a comparison is unavailable; it does not silently pass or compare with another machine.

Run \`npm run benchmark:update\` to measure and append a new entry, then review and commit this file. Existing entries remain unchanged. The comparison fails when a phase is both more than 25% and more than 250 ms slower. Recording a new entry is not proof that a regression has been fixed; review the changes before accepting it as the next reference.

## Measurement method

Each timing is a median: three samples in the first batch, then five in the subsequent batch. ${phaseLimitations}

The small fixture exercises individual analyzers. The monorepo fixture has a root workspace and 12 package workspaces. These synthetic measurements are not a promise of real-project scan speed. Run under similar load and record any relevant VM or machine changes. Source commits are recorded because the harness and analyzers can change too.

## GitHub-hosted runner reference

For public repositories, GitHub lists these standard runners (checked September 30, 2026):

| Runner label | CPU allocation | Memory | Architecture |
| --- | --- | --- | --- |
| \`ubuntu-latest\` | 4 CPUs | 16 GB | x64 |
| \`windows-latest\` | 4 CPUs | 16 GB | x64 |
| \`macos-latest\` | 3 CPUs (Apple M1) | 7 GB | arm64 |

Source: [GitHub-hosted runners reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners#standard-github-hosted-runners-for-public-repositories). Private-repository allocations can differ. This is reference information, not a reconstruction of the original run's unknown configuration.

`;

function deltaText(current: number, previous: number): string {
  const delta = Math.round((current - previous) * 10_000) / 10_000;
  const prefix = delta > 0 ? "+" : "";
  return `${prefix}${delta} ms (${previous === 0 ? "previously 0" : `${prefix}${(((current - previous) / previous) * 100).toFixed(2)}%`})`;
}

export function renderBenchmarkRun(
  baseline: Baselines,
  previous?: BenchmarkRun,
): string {
  const environment = baseline.environment;
  const title = environment
    ? `${environment.capturedAt} — ${environment.githubActions ? "GitHub Actions" : (environment.machine ?? "Local")} / ${environment.cpuModels.join(", ")} / ${environment.memoryBytes / 1024 ** 3} GiB`
    : "Historical GitHub Actions — measurement date unrecorded";
  const lines = [
    `## Run: ${cell(title)}`,
    "",
    "### Measurement environment",
    "",
    "| Detail | Recorded value |",
    "| --- | --- |",
    ...environmentDetails(baseline).map(
      ([label, value]) => `| ${label} | ${cell(value)} |`,
    ),
    "",
    "### Results",
    "",
  ];
  for (const [fixture, phases] of Object.entries(baseline.fixtures)) {
    lines.push(
      `#### ${cell(fixture)} fixture`,
      "",
      "| Phase | First batch (ms) | Subsequent batch (ms) |",
      "| --- | ---: | ---: |",
      ...Object.entries(phases).map(
        ([name, value]) =>
          `| ${cell(phaseLabel(name))} | ${value.coldMs} | ${value.warmMs} |`,
      ),
      "",
    );
  }
  lines.push("### Change from previous matching environment", "");
  if (!previous)
    lines.push(
      "No earlier run has matching recorded environment details. These measurements establish a starting point for this environment.",
      "",
    );
  else {
    lines.push(
      `Compared with: ${cell(previous.title)}.`,
      "",
      "| Fixture / phase | First batch change | Subsequent batch change |",
      "| --- | ---: | ---: |",
    );
    for (const [fixture, phases] of Object.entries(baseline.fixtures)) {
      for (const [name, value] of Object.entries(phases)) {
        const before = previous.fixtures[fixture]?.[name];
        lines.push(
          `| ${cell(fixture)} / ${cell(phaseLabel(name))} | ${before ? deltaText(value.coldMs, before.coldMs) : "New phase"} | ${before ? deltaText(value.warmMs, before.warmMs) : "New phase"} |`,
        );
      }
    }
    lines.push("");
  }
  return lines.join("\n");
}

export function renderBaselineReport(baseline: Baselines): string {
  return historyIntroduction + renderBenchmarkRun(baseline);
}

export function parseBenchmarkHistory(markdown: string): BenchmarkRun[] {
  const sections = markdown
    .replaceAll("\r\n", "\n")
    .split(/^## Run: /m)
    .slice(1);
  if (!sections.length)
    throw new Error("Invalid benchmark history: no recorded runs");
  const titles = new Set<string>();
  return sections.map((section) => {
    const title = section.slice(0, section.indexOf("\n")).trim();
    if (!title || titles.has(title))
      throw new Error(
        "Invalid benchmark history: duplicate or missing run title",
      );
    titles.add(title);
    const details: Record<string, string> = Object.create(null);
    const environment = section
      .split("### Measurement environment\n")[1]
      ?.split("### Results\n")[0];
    if (!environment)
      throw new Error("Invalid benchmark history: missing environment table");
    for (const line of environment.split(/\r?\n/)) {
      if (!line.trim().startsWith("|")) continue;
      const cells = line
        .trim()
        .split(/(?<!\\)\|/)
        .slice(1, -1)
        .map((value) => value.trim());
      if (cells.length !== 2)
        throw new Error("Invalid benchmark history: malformed environment row");
      const [key, value] = cells as [string, string];
      if (key === "Detail" || /^:?-+:?$/.test(key)) continue;
      if (Object.hasOwn(details, key))
        throw new Error(
          "Invalid benchmark history: duplicate environment detail",
        );
      details[key] = value;
    }
    const { fixtures } = parseBaselineReport(
      section
        .replace(/^#### /gm, "### ")
        .replace(/^### Results\r?$/m, "## Results")
        .replace(
          /^### Change from previous matching environment\r?$/m,
          "## Changes",
        ),
    );
    return { title, details, fixtures };
  });
}

export async function writeBaselineReport(
  directory: string,
  baseline: Baselines,
): Promise<void> {
  const path = join(directory, "README.md");
  let existing: string;
  try {
    existing = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await writeFile(path, renderBaselineReport(baseline));
    return;
  }
  const runs = parseBenchmarkHistory(existing);
  const previous = baseline.environment
    ? matchingRun(runs, baseline.environment)
    : undefined;
  const entry = renderBenchmarkRun(baseline, previous);
  // Validate the complete document before writing; never replace prior results.
  parseBenchmarkHistory(existing + "\n" + entry);
  await appendFile(path, "\n" + entry);
}

export function parseBaselineReport(
  markdown: string,
): Pick<Baselines, "fixtures"> {
  const fixtures: Baselines["fixtures"] = Object.create(null);
  let inResults = false;
  let phases: Baselines["fixtures"][string] | undefined;
  const invalid = (detail: string): never => {
    throw new Error(`Invalid benchmark baseline: ${detail}`);
  };
  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trim();
    if (!inResults) {
      if (line === "## Results") inResults = true;
      continue;
    }
    if (line.startsWith("## ")) break;
    const fixture = /^### ([a-zA-Z0-9-]+) fixture$/.exec(line)?.[1];
    if (fixture) {
      if (Object.hasOwn(fixtures, fixture))
        invalid(`duplicate fixture ${fixture}`);
      phases = Object.create(null) as Baselines["fixtures"][string];
      fixtures[fixture] = phases;
      continue;
    }
    if (!phases || !line) continue;
    if (
      /^\|\s*Phase\s*\|\s*First batch \(ms\)\s*\|\s*Subsequent batch \(ms\)\s*\|$/.test(
        line,
      ) ||
      /^\|(?:\s*:?-{3,}:?\s*\|){3}$/.test(line)
    )
      continue;
    const row =
      /^\|\s*([^|]+?)\s*\|\s*([0-9]+(?:\.[0-9]+)?)\s*\|\s*([0-9]+(?:\.[0-9]+)?)\s*\|$/.exec(
        line,
      );
    if (!row) invalid(`malformed timing row: ${line}`);
    const [, label, cold, warm] = row!;
    const name = Object.entries(phaseLabels).find(
      ([, value]) => value === label,
    )?.[0];
    if (!name) invalid(`unknown phase label: ${label}`);
    const coldMs = Number(cold);
    const warmMs = Number(warm);
    if (!Number.isFinite(coldMs) || !Number.isFinite(warmMs))
      invalid("non-finite timing");
    if (Object.hasOwn(phases, name!)) invalid(`duplicate phase ${name}`);
    phases[name!] = { coldMs, warmMs };
  }
  if (Object.keys(fixtures).length === 0) invalid("no fixture tables found");
  for (const [fixture, timings] of Object.entries(fixtures)) {
    if (Object.keys(timings).length === 0) invalid(`empty fixture ${fixture}`);
  }
  return { fixtures };
}
