import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { cpus, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execa } from "execa";

// External harness: imports ONLY the requested immutable build in a fresh child.
const here = fileURLToPath(import.meta.url);
const args = process.argv.slice(2);
function option(name: string, fallback?: string): string {
  const value = args[args.indexOf(name) + 1];
  if (!args.includes(name)) {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing ${name}`);
  }
  if (!value || value.startsWith("--")) throw new Error(`Invalid ${name}`);
  return value;
}
const moduleAt = (root: string, path: string) =>
  import(pathToFileURL(join(root, "dist", path)).href);

async function worker() {
  const root = option("--implementation-root");
  const repo = option("--repository");
  const {
    withAnalysisSession,
    DEFAULT_ANALYSIS_SESSION_DEPENDENCIES: defaults,
  } = await moduleAt(root, "scan/analysis-session.js");
  const { createLocalAnalyzerExecutor } = await moduleAt(
    root,
    "checks/runner/executor.js",
  );
  const timings: Record<string, number> = {};
  const dependencies = { ...defaults, dispatch: async () => [] };
  for (const [method, phase] of Object.entries({
    loadIndexConfig: "configuration",
    discoverIndexChangeSet: "metadata",
    buildIndexSnapshots: "snapshots",
    addIndexLineRanges: "ranges",
  })) {
    dependencies[method] = async (...parameters: unknown[]) => {
      const started = performance.now();
      try {
        return await defaults[method](...parameters);
      } finally {
        timings[phase] = (timings[phase] ?? 0) + performance.now() - started;
      }
    };
  }
  let firstInspection = Infinity;
  let lastInspection = 0;
  dependencies.inspectRepository = async (...parameters: unknown[]) => {
    firstInspection = Math.min(firstInspection, performance.now());
    try {
      return await defaults.inspectRepository(...parameters);
    } finally {
      lastInspection = Math.max(lastInspection, performance.now());
    }
  };
  const local = createLocalAnalyzerExecutor();
  const started = performance.now();
  let result;
  try {
    result = await withAnalysisSession(
      {
        repositoryRoot: repo,
        dependencies,
        executor: {
          async openSession(parameters: unknown) {
            const start = performance.now();
            try {
              return await local.openSession(parameters);
            } finally {
              timings.capture = performance.now() - start;
            }
          },
          close: () => local.close(),
        },
      },
      async (session: { kind: string }) => session.kind,
    );
  } finally {
    await local.close();
  }
  if (!result.completed || result.value !== "analyzed")
    throw new Error("Preparation sample did not analyze the fixture");
  timings.inspections = lastInspection - firstInspection;
  timings.total = performance.now() - started;
  process.stdout.write(
    JSON.stringify({
      pid: process.pid,
      timings,
      peakRssBytes: process.resourceUsage().maxRSS * 1024,
    }),
  );
}

async function fixture(root: string, count: number, scenario: string) {
  const git = (parameters: string[]) =>
    execa("git", parameters, {
      cwd: root,
      env: {
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
        GIT_AUTHOR_NAME: "Benchmark",
        GIT_AUTHOR_EMAIL: "bench@example.invalid",
        GIT_COMMITTER_NAME: "Benchmark",
        GIT_COMMITTER_EMAIL: "bench@example.invalid",
        HUSKY: "0",
      },
    });
  await git(["init", "--quiet"]);
  await writeFile(
    join(root, "package.json"),
    '{"name":"snapshot-benchmark","private":true,"workspaces":["web","e2e","extension"]}',
  );
  await writeFile(
    join(root, ".zedbeerc.jsonc"),
    '{"schemaVersion":1,"profile":"recommended","checks":{"formatting":"off","lint":"off","types":"error","secrets":"off","cyclomaticComplexity":"off","readabilityComplexity":"off","structuralSecurity":"off","reactCorrectness":"off","reactAccessibility":"off"}}',
  );
  for (const name of ["web", "e2e", "extension"]) {
    await mkdir(join(root, name, "src", "deep", "nested"), { recursive: true });
    await writeFile(
      join(root, name, "package.json"),
      JSON.stringify({ name, private: true }),
    );
    await writeFile(
      join(root, name, "tsconfig.json"),
      '{"compilerOptions":{"strict":true,"types":[],"resolveJsonModule":true,"esModuleInterop":true},"include":["src"]}',
    );
  }
  // Bounded fixture generation; file count excludes Git internals and cache.
  for (let offset = 0; offset < count; offset += 32)
    await Promise.all(
      Array.from({ length: Math.min(32, count - offset) }, async (_, i) => {
        const index = offset + i;
        const name = ["web", "e2e", "extension"][index % 3]!;
        await writeFile(
          join(
            root,
            name,
            "src",
            index % 2 ? "deep/nested" : "",
            `value-${index}.ts`,
          ),
          `export const value = ${index};\n`,
        );
      }),
    );
  await writeFile(join(root, "web", "src", "data.json"), '{"value":1}\n');
  if (scenario === "large")
    await writeFile(
      join(root, "unchanged.bin"),
      Buffer.alloc(16 * 1024 * 1024, 65),
    );
  await git(["add", "."]);
  await git(["commit", "--quiet", "-m", "baseline"]);
  if (scenario === "ts")
    await writeFile(
      join(root, "web", "src", "value-0.ts"),
      "export const value = 42;\n",
    );
  else if (scenario === "config")
    await writeFile(
      join(root, "web", "tsconfig.json"),
      '{"compilerOptions":{"strict":false,"types":[]},"include":["src"]}',
    );
  else await writeFile(join(root, "web", "src", "data.json"), '{"value":2}\n');
  await git(["add", "."]);
  const manifest = await git(["ls-files", "--stage", "-z"]);
  return {
    files: manifest.stdout.split("\0").filter(Boolean).length,
    manifestHash: createHash("sha256").update(manifest.stdout).digest("hex"),
  };
}

async function coordinator() {
  const roots = [resolve(option("--implementation-root"))];
  if (args.includes("--baseline-root"))
    roots.unshift(resolve(option("--baseline-root")));
  const samples = Number(option("--samples", "15"));
  if (!Number.isSafeInteger(samples) || samples < 1)
    throw new Error("Invalid sample count");
  const sizes = option("--sizes", "100,4000,20000").split(",").map(Number);
  const scenarios = option("--scenarios", "json,ts,config,large").split(",");
  if (
    sizes.some((n) => !Number.isSafeInteger(n) || n < 1) ||
    scenarios.some((s) => !["json", "ts", "config", "large"].includes(s))
  )
    throw new Error("Invalid fixtures");
  const output = resolve(option("--output"));
  const temporary = await mkdtemp(join(tmpdir(), "zedbee-preparation-bench-"));
  const results: unknown[] = [];
  const identities = await Promise.all(
    roots.map(async (root) => ({
      root,
      commit: (await execa("git", ["rev-parse", "HEAD"], { cwd: root })).stdout,
      tree: (await execa("git", ["rev-parse", "HEAD^{tree}"], { cwd: root }))
        .stdout,
      dirty: (await execa("git", ["status", "--porcelain"], { cwd: root }))
        .stdout,
    })),
  );
  try {
    for (const count of sizes)
      for (const scenario of scenarios) {
        const repository = join(temporary, `${count}-${scenario}`);
        await mkdir(repository);
        const manifest = await fixture(repository, count, scenario);
        for (let sample = -1; sample < samples; sample++) {
          const order = sample % 2 === 0 ? roots : [...roots].reverse();
          for (const root of order) {
            const child = await execa(
              process.execPath,
              [
                "--experimental-strip-types",
                here,
                "--worker",
                "--implementation-root",
                root,
                "--repository",
                repository,
              ],
              {
                env: {
                  NODE_OPTIONS: "",
                  NODE_PATH: "",
                  ZEDBEE_TELEMETRY_DISABLED: "1",
                  ZEDBEE_NO_UPDATE_CHECK: "1",
                },
              },
            );
            if (sample >= 0)
              results.push({
                root,
                count,
                scenario,
                sample,
                ...manifest,
                ...JSON.parse(child.stdout),
              });
          }
        }
      }
    const artifact = {
      schemaVersion: 1,
      kind: "local-preparation",
      samples,
      identities,
      harnessHash: createHash("sha256")
        .update(await readFile(here))
        .digest("hex"),
      environment: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        cpu: cpus()[0]?.model,
      },
      memory: "per-child maxRSS normalized from KiB to bytes",
      percentile: "nearest rank",
      results,
    };
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify(artifact, null, 2) + "\n");
    process.stdout.write(
      `Saved ${results.length} preparation samples to ${output}\n`,
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (args.includes("--worker")) await worker();
else await coordinator();
