import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createObservationCacheKey } from "../dist/cache/key.js";
import { createSecretsAdapter } from "../dist/checks/secrets/adapter.js";
import { structuralSecurityAdapter } from "../dist/checks/structural-security/adapter.js";
import { createVulnerabilitiesAdapter } from "../dist/checks/vulnerabilities/adapter.js";
import { DEFAULT_CHECK_ADAPTERS } from "../dist/scan/run-scan.js";
import { observationCheckResult } from "../dist/checks/observation-result.js";
import { createFilePolicyResolver } from "../dist/config/file-policy.js";
import { resolveConfig } from "../dist/config/profiles.js";
import { inspectRepository } from "../dist/inspection/inspect-repository.js";
import { renderJson } from "../dist/renderers/json.js";
import { loadAnalyzerAdapter } from "../dist/checks/runner/registry.js";
import { createLocalAnalyzerExecutor } from "../dist/checks/runner/executor.js";
import type { CheckId } from "../dist/config/schema.js";
import type * as Lifecycle from "./lifecycle.mjs";
import type * as PhaseSession from "./phase-session.mjs";

type FixtureName = "small" | "monorepo";
type Phase = () => Promise<void> | void;

interface Measurement {
  coldMs: number;
  warmMs: number;
}

interface Baselines {
  schemaVersion: 1;
  fixtures: Record<string, Record<string, Measurement>>;
}

const here = dirname(fileURLToPath(import.meta.url));
const baselinePath = resolve(here, "baselines.json");
const update = process.argv.includes("--update");
const smoke = process.env.ZEDBEE_BENCHMARK_MODE === "smoke";
const inProcessReference = process.argv.includes("--in-process-reference");

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!;
}

async function measure(phase: Phase, iterations: number): Promise<number> {
  const durations: number[] = [];
  for (let index = 0; index < iterations; index += 1) {
    const started = performance.now();
    await phase();
    durations.push(performance.now() - started);
  }
  return median(durations);
}

async function writeFixture(
  root: string,
  fixture: FixtureName,
  value: number,
): Promise<void> {
  const workspaces =
    fixture === "small"
      ? ["."]
      : [
          ".",
          ...Array.from(
            { length: 12 },
            (_, index) => `packages/package-${index}`,
          ),
        ];
  await writeFile(
    join(root, "package.json"),
    `${JSON.stringify({ name: `${fixture}-fixture`, private: true, dependencies: { react: "19.2.0", "react-dom": "19.2.0" }, ...(fixture === "small" ? {} : { workspaces: ["packages/*"] }) })}\n`,
  );
  await writeFile(
    join(root, "package-lock.json"),
    `${JSON.stringify({ name: `${fixture}-fixture`, lockfileVersion: 3, packages: {} })}\n`,
  );
  for (const workspace of workspaces) {
    const directory = workspace === "." ? root : join(root, workspace);
    await mkdir(join(directory, "src"), { recursive: true });
    if (workspace !== ".") {
      await writeFile(
        join(directory, "package.json"),
        `${JSON.stringify({ name: workspace.replace("/", "-") })}\n`,
      );
    }
    await writeFile(
      join(directory, "tsconfig.json"),
      `${JSON.stringify({ compilerOptions: { strict: true, jsx: "react-jsx", noEmit: true }, include: ["src"] })}\n`,
    );
    await writeFile(
      join(directory, "src", "value.ts"),
      `export const value = ${value};\nexport function parse(input: string) { return JSON.parse(input); }\n`,
    );
    if (workspace === ".") {
      await writeFile(
        join(directory, "src", "view.tsx"),
        'export const View = () => <button type="button">Ready</button>;\n',
      );
    }
  }
}

const benchmarkSecrets = createSecretsAdapter({
  lintSource: async ({ source }) => ({
    filePath: source.filePath,
    sourceContent: source.content,
    sourceContentType: "text",
    messages: [],
  }),
  comparisonKey: () => new Uint8Array(32),
});

const benchmarkVulnerabilities = createVulnerabilitiesAdapter({
  parseInventory: async () => [],
  client: {
    query: async () => new Map(),
    probe: async () => undefined,
  },
});

const referenceAdapters = inProcessReference
  ? await Promise.all(
      DEFAULT_CHECK_ADAPTERS.map((adapter) =>
        loadAnalyzerAdapter(adapter.id as CheckId),
      ),
    )
  : DEFAULT_CHECK_ADAPTERS;
const benchmarkAdapters = referenceAdapters.map((adapter) =>
  adapter.id === "secrets"
    ? benchmarkSecrets
    : adapter.id === "vulnerabilities"
      ? benchmarkVulnerabilities
      : adapter,
);

async function phases(fixture: FixtureName, scratch: string) {
  const baselineRoot = join(scratch, fixture, "baseline");
  const targetRoot = join(scratch, fixture, "target");
  await mkdir(baselineRoot, { recursive: true });
  await mkdir(targetRoot, { recursive: true });
  await writeFixture(baselineRoot, fixture, 1);
  await writeFixture(targetRoot, fixture, 2);
  const [baselineInspection, targetInspection] = await Promise.all([
    inspectRepository(baselineRoot),
    inspectRepository(targetRoot),
  ]);
  const sourceFiles = targetInspection.workspaces.flatMap(
    (workspace) => workspace.sourceFiles,
  );
  const changeSet = {
    files: new Map(
      [...sourceFiles, "package-lock.json"].map((path) => [
        path,
        {
          path,
          status: "modified" as const,
          addedRanges: [{ start: 1, end: 2 }],
        },
      ]),
    ),
    isEmpty: false,
    containsAddedLine(file: string, line: number) {
      return (
        this.files
          .get(file)
          ?.addedRanges.some(
            (range) => line >= range.start && line <= range.end,
          ) ?? false
      );
    },
  };
  const config = resolveConfig({ schemaVersion: 1, profile: "thorough" });
  const policyForFile = createFilePolicyResolver(config, changeSet);
  const inspectionContext = {
    repositoryRoot: resolve(here, ".."),
    changeSet,
    config,
    baselineInspection,
    targetInspection,
  };
  const applicability =
    await structuralSecurityAdapter.inspect(inspectionContext);
  if (!applicability.applies || applicability.targets.length === 0) {
    throw new Error("Benchmark fixture is not structurally analyzable.");
  }
  const target = applicability.targets[0]!;
  const runContext = {
    ...inspectionContext,
    snapshots: {
      baselineDir: baselineRoot,
      targetDir: targetRoot,
      baselineRef: "HEAD" as const,
      targetRef: "index" as const,
      unsupportedEntries: [],
    },
    target,
    policy: config.checks.structuralSecurity,
    policyForFile,
    signal: new AbortController().signal,
  };
  const observations = await structuralSecurityAdapter.collect(runContext);
  const report = {
    schemaVersion: 1 as const,
    outcome: "pass" as const,
    exitCode: 0 as const,
    repositoryRoot: "<repository>",
    mode: "index" as const,
    baseline: "HEAD" as const,
    target: "index" as const,
    changedFileCount: changeSet.files.size,
    startedAt: "2026-08-16T00:00:00.000Z",
    durationMs: 0,
    configuredPathExclusions: [],
    appliedPathExclusions: [],
    networkDisclosures: [],
    presentationPolicy: {
      terminalFindingLimit: 25,
      temporaryReportMaxAge: "24h",
      persistSourceExcerpts: false,
      agentGuidance: { opening: "", nextStep: "" },
    },
    summary: { passed: 1, warnings: 0, failed: 0, incomplete: 0, findings: [] },
    checks: [
      {
        checkId: "structuralSecurity",
        status: "completed" as const,
        durationMs: 0,
        findings: [],
      },
    ],
  };

  const measuredPhases: Record<string, Phase> = {
    snapshot: async () => {
      await createObservationCacheKey({
        checkId: "structuralSecurity",
        engineIdentity: "ast-grep@0.45.1+zedbee-structural-rules-v1",
        policy: config.checks.structuralSecurity,
        checkTarget: target,
        baselineRoot,
        targetRoot,
        mode: "index",
        baseline: "HEAD",
        target: "index",
        relevantConfig: {
          fixture,
          workspaces: targetInspection.workspaces.length,
        },
        nodeVersion: process.versions.node,
        platform: process.platform,
        arch: process.arch,
      });
    },
    inspection: async () => {
      await inspectRepository(targetRoot);
    },
    "adapter.structuralSecurity.collect": async () => {
      await structuralSecurityAdapter.collect(runContext);
    },
    attribution: async () => {
      await observationCheckResult(
        "structuralSecurity",
        observations,
        runContext,
        true,
      );
    },
    rendering: () => {
      renderJson(report);
    },
  };
  if (fixture === "small") {
    for (const adapter of benchmarkAdapters) {
      const adapterApplicability = await adapter.inspect(inspectionContext);
      if (!adapterApplicability.applies) {
        throw new Error(
          `${fixture} benchmark does not exercise ${adapter.id}: ${adapterApplicability.reason}`,
        );
      }
      measuredPhases[`adapter.${adapter.id}.execute`] = async () => {
        for (const adapterTarget of adapterApplicability.targets) {
          const adapterContext = {
            ...inspectionContext,
            snapshots: runContext.snapshots,
            target: adapterTarget,
            policy: config.checks[adapter.id as keyof typeof config.checks],
            policyForFile,
            signal: runContext.signal,
          };
          if (adapter.output === "observations") {
            await adapter.collect(adapterContext);
          } else {
            await adapter.runLegacy(adapterContext);
          }
        }
      };
    }
  }
  return measuredPhases;
}

function rounded(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

async function main(): Promise<void> {
  if (process.argv.includes("--lifecycle")) {
    if (update || inProcessReference)
      throw new Error(
        "Lifecycle scenarios never overwrite historical phase targets.",
      );
    const repository = process.argv[process.argv.indexOf("--repository") + 1];
    if (!process.argv.includes("--repository") || !repository)
      throw new Error(
        "--lifecycle requires --repository <prepared Git fixture>.",
      );
    const workers = Number(
      process.argv[process.argv.indexOf("--workers") + 1] ?? 2,
    );
    const concurrency = process.argv.includes("--workers") ? workers : 2;
    if (concurrency !== 1 && concurrency !== 2 && concurrency !== 4)
      throw new Error("--workers must be 1, 2, or 4.");
    const { runLifecycleBenchmark } = (await import(
      new URL("./lifecycle.mts", import.meta.url).href
    )) as typeof Lifecycle;
    process.stdout.write(
      `${JSON.stringify(await runLifecycleBenchmark(resolve(repository), concurrency, smoke ? 1 : 5), null, 2)}\n`,
    );
    return;
  }
  if (inProcessReference && update)
    throw new Error(
      "Corrected in-process references never overwrite historical phase targets.",
    );
  const scratch = await mkdtemp(join(tmpdir(), "zedbee-bench-"));
  const executor = createLocalAnalyzerExecutor();
  try {
    const { withPhaseSession } = (await import(
      new URL("./phase-session.mts", import.meta.url).href
    )) as typeof PhaseSession;
    const measurements: Baselines = { schemaVersion: 1, fixtures: {} };
    for (const fixture of ["small", "monorepo"] as const) {
      const measureFixture = async () => {
        const fixturePhases = await phases(fixture, scratch);
        const results: Record<string, Measurement> = {};
        for (const [name, phase] of Object.entries(fixturePhases)) {
          process.stderr.write(`Benchmarking ${fixture}/${name}\n`);
          results[name] = {
            coldMs: rounded(await measure(phase, 3)),
            warmMs: rounded(await measure(phase, 5)),
          };
        }
        return results;
      };
      measurements.fixtures[fixture] = inProcessReference
        ? await measureFixture()
        : await withPhaseSession(executor, measureFixture);
    }

    if (update) {
      await writeFile(
        baselinePath,
        `${JSON.stringify(measurements, null, 2)}\n`,
      );
      process.stdout.write("Benchmark baselines updated.\n");
      return;
    }

    const report = {
      ...measurements,
      kind: inProcessReference
        ? "corrected-in-process-phase-reference"
        : "within-session-phase-comparison",
      limitations:
        (inProcessReference
          ? "Phase samples call engines directly in the benchmark process. "
          : "Repeated phase samples share one fixture-scoped analysis session; final session cleanup is outside phase timings. ") +
        "These are not complete CLI timings. coldMs/warmMs are historical field names, not fresh/warm process guarantees. Historical Secretlint and OSV substitutions remain; the snapshot phase measures cache-key hashing, not Git materialization.",
    };
    if (smoke || inProcessReference) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      return;
    }

    const baselines = JSON.parse(
      await readFile(baselinePath, "utf8"),
    ) as Baselines;
    const regressions: string[] = [];
    for (const [fixture, phases] of Object.entries(measurements.fixtures)) {
      for (const [phase, current] of Object.entries(phases)) {
        const baseline = baselines.fixtures[fixture]?.[phase];
        if (baseline === undefined) {
          regressions.push(`${fixture}/${phase}: missing baseline`);
          continue;
        }
        for (const field of ["coldMs", "warmMs"] as const) {
          const delta = current[field] - baseline[field];
          if (current[field] > baseline[field] * 1.25 && delta > 250) {
            regressions.push(
              `${fixture}/${phase}/${field}: ${current[field]}ms versus ${baseline[field]}ms`,
            );
          }
        }
      }
    }
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (regressions.length > 0) {
      throw new Error(`Benchmark regressions:\n${regressions.join("\n")}`);
    }
  } finally {
    // Prove worker cleanup before removing the fixtures they could still read.
    await executor.close();
    if (
      dirname(scratch) === tmpdir() &&
      basename(scratch).startsWith("zedbee-bench-")
    ) {
      await rm(scratch, { recursive: true, force: true });
    }
  }
}

await main();
