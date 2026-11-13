import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { benchmarkSamples } from "./sample-modes.mjs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { platform, release, arch } from "node:os";
const option = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? fallback : process.argv[i + 1];
};
const candidatePath = resolve(
  option("--candidate", new URL("..", import.meta.url).pathname),
);
async function packageDigest(root) {
  const hash = createHash("sha256");
  const files = (
    await readdir(resolve(root, "dist"), { recursive: true })
  ).sort();
  for (const file of files) {
    try {
      const data = await readFile(resolve(root, "dist", file));
      hash.update(file);
      hash.update(data);
    } catch (error) {
      if (error.code !== "EISDIR") throw error;
    }
  }
  hash.update(await readFile(resolve(root, "package.json")));
  return hash.digest("hex");
}
const load = async (root) => ({
  ...(await import(pathToFileURL(resolve(root, "dist/scan/run-scan.js")).href)),
  ...(await import(
    pathToFileURL(resolve(root, "dist/checks/runner/executor.js")).href
  )),
  ...(await import(pathToFileURL(resolve(root, "dist/cache/store.js")).href)),
  metadata: {
    version: JSON.parse(await readFile(resolve(root, "package.json"), "utf8"))
      .version,
    hash: await packageDigest(root),
  },
});
const candidate = await load(candidatePath);
const mode = option("--mode", "cold");
const sampleCount = Number(option("--samples", "10"));
const workers = Number(option("--workers", "2"));
const diagnostics = process.argv.includes("--diagnostics");
const parallelScans = Number(option("--parallel", "1"));
if (![1, 2].includes(parallelScans)) throw Error("Parallel scans must be1or2");
const onlyScenario = option("--scenario", undefined);
if (![1, 2, 4].includes(workers)) throw Error("Workers must be 1, 2, or 4");
const referenceIndex = process.argv.indexOf("--reference");
const referencePath =
  referenceIndex < 0 ? undefined : process.argv[referenceIndex + 1];
const implementations = [["candidate", candidate]];
if (referencePath !== undefined) {
  implementations.unshift(["reference", await load(resolve(referencePath))]);
}
const base = await mkdtemp(join(tmpdir(), "swarm-change-aware-bench-"));
const samples = [];
// Run after npm run build; --reference accepts a trusted installed Zedbee package.
// Timings are supporting evidence; job selection and outcomes are stable gates.
for (const scenario of [
  "python",
  "ignore-and-untrack",
  "markdown-delete",
  "markdown-edit",
  "type-regression",
  "large-source",
]) {
  if (onlyScenario && scenario !== onlyScenario) continue;
  const root = join(base, scenario);
  await mkdir(root);
  const git = (...args) =>
    execFileSync("git", args, { cwd: root, stdio: "pipe" });
  const write = async (path, text) => {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  };
  git("init", "-q");
  git("config", "user.name", "Swarm benchmark");
  git("config", "user.email", "benchmark@example.invalid");
  git("config", "core.hooksPath", "/dev/null");
  await write("package.json", '{"name":"benchmark","private":true}\n');
  await write(
    "tsconfig.json",
    '{"compilerOptions":{"strict":true,"types":[]},"include":["src"]}\n',
  );
  await write("src/value.ts", "export const value: number = 1;\n");
  await write(".gitignore", "node_modules/\n");
  await write("README.md", "A document.\n");
  await write("app.py", "value = 1\n");
  if (scenario === "large-source") {
    for (const workspace of ["web", "extension", "e2e"]) {
      await write(
        `${workspace}/package.json`,
        JSON.stringify({ name: `bench-${workspace}`, private: true }),
      );
      await write(
        `${workspace}/tsconfig.json`,
        JSON.stringify({
          compilerOptions: { strict: true, types: [] },
          include: ["src"],
        }),
      );
      for (let i = 0; i < 100; i++)
        await write(
          `${workspace}/src/item-${i}.ts`,
          `export const item${i}: number = ${i};\n`,
        );
    }
  }
  git("add", ".");
  git("commit", "-qm", "baseline");
  if (scenario === "python") await write("app.py", "value = 2\n");
  if (scenario === "ignore-and-untrack") {
    await write(".gitignore", "node_modules/\n.cache/\n");
    git("rm", "--cached", "README.md");
  }
  if (scenario === "markdown-delete") git("rm", "README.md");
  if (scenario === "markdown-edit")
    await write("README.md", "An edited document.\n");
  if (scenario === "type-regression")
    await write("src/value.ts", 'export const value: number = "wrong";\n');
  if (scenario === "large-source")
    await write("web/src/item-0.ts", 'export const item0: number = "wrong";\n');
  git("add", "-u");
  const roots = [root];
  if (parallelScans === 2) {
    const peer = join(base, `${scenario}-peer`);
    git("worktree", "add", "--detach", peer, "HEAD");
    execFileSync("git", ["apply", "--index"], {
      cwd: peer,
      input: git("diff", "--cached", "--binary"),
      stdio: ["pipe", "pipe", "pipe"],
    });
    roots.push(peer);
  }
  const ordered =
    (samples.length / (sampleCount * implementations.length)) % 2
      ? [...implementations].reverse()
      : implementations;
  for (const [version, implementation] of ordered) {
    let index = 0;
    const observationCache = new implementation.ObservationCacheStore({
      root: join(base, "observation-cache", scenario, version),
    });
    const measured = await benchmarkSamples({
      mode,
      samples: sampleCount,
      open: async () =>
        implementation.createLocalAnalyzerExecutor({ concurrency: workers }),
      close: async (executor) => executor.close(),
      run: async (executor, cache) => {
        const jobs = [];
        const diagnosticSummaries = [];
        let cacheHits = 0,
          cacheMisses = 0;
        const cacheAdapter = {
          get: async (key) => {
            const value = await observationCache.get(key);
            if (value === undefined) cacheMisses++;
            else cacheHits++;
            return value;
          },
          set: (key, value) => observationCache.set(key, value),
        };
        const start = performance.now();
        const reports = await Promise.all(
          roots.map((repositoryRoot) =>
            implementation.runScan({
              repositoryRoot,
              executor,
              cache: cache ? cacheAdapter : false,
              ...(diagnostics
                ? {
                    onPerformanceSummary: (value) => {
                      diagnosticSummaries.push(value);
                    },
                  }
                : {}),
              sourceExcerpts: "exclude",
              onEvent: (e) => {
                if (e.type === "check-running") jobs.push(e.checkId);
              },
            }),
          ),
        );
        const expected = ["type-regression", "large-source"].includes(scenario)
          ? "blocked"
          : "pass";
        for (const item of reports) {
          if (item.outcome !== expected)
            throw Error(
              `${scenario}: expected ${expected}, received ${item.outcome}`,
            );
          if (
            expected === "blocked" &&
            !item.summary.findings.some(
              (f) => f.check === "types" && f.rule === "typescript/TS2322",
            )
          )
            throw Error("Expected actual TypeScript assignment regression");
        }
        if (
          version === "candidate" &&
          !["type-regression", "large-source"].includes(scenario) &&
          jobs.some((id) => id === "types" || id === "lint")
        )
          throw Error("Irrelevant compiler job scheduled");
        const report = reports[0];
        if (reports.some((other) => other.outcome !== report.outcome))
          throw Error("Concurrent scan outcome mismatch");
        return {
          scenario,
          version,
          package: implementation.metadata,
          sample: index++,
          mode,
          parallelScans,
          scanDurationsMs: reports.map((r) => r.durationMs),
          workers,
          runtime: process.version,
          os: `${platform()} ${release()} ${arch()}`,
          elapsedMs: performance.now() - start,
          durationMs: report.durationMs,
          outcome: report.outcome,
          cacheHits,
          cacheMisses,
          ...(diagnostics ? { diagnosticSummaries } : {}),
          jobs,
          memory: "unavailable-in-process",
        };
      },
    });
    samples.push(...measured);
  }
}
const med = (a) => a.sort((x, y) => x - y)[Math.floor(a.length / 2)];
const summaries = [];
for (const scenario of [...new Set(samples.map((s) => s.scenario))])
  for (const [version] of implementations) {
    const s = samples.filter(
      (s) => s.scenario === scenario && s.version === version,
    );
    summaries.push({
      scenario,
      version,
      medianMs: med(s.map((s) => s.elapsedMs)),
      p90Ms: s.map((x) => x.elapsedMs).sort((a, b) => a - b)[
        Math.ceil(s.length * 0.9) - 1
      ],
      minMs: Math.min(...s.map((x) => x.elapsedMs)),
      maxMs: Math.max(...s.map((x) => x.elapsedMs)),
      jobs: s[0].jobs,
      outcomes: [...new Set(s.map((s) => s.outcome))],
    });
  }
const result = {
  node: process.version,
  platform: process.platform,
  cache: mode === "warm-cache",
  warmup: mode === "cold" ? 0 : 1,
  samples,
  summaries,
};
await (
  await import("node:fs/promises")
).rm(base, { recursive: true, force: true });
console.log(JSON.stringify(result, null, 2));
