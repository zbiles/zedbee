import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
const candidate = await import("../dist/scan/run-scan.js");
const referenceIndex = process.argv.indexOf("--reference");
const referencePath =
  referenceIndex < 0 ? undefined : process.argv[referenceIndex + 1];
const implementations = [["candidate", candidate.runScan]];
if (referencePath !== undefined) {
  const { pathToFileURL } = await import("node:url");
  const { resolve } = await import("node:path");
  const baseline = await import(
    pathToFileURL(resolve(referencePath, "dist/scan/run-scan.js")).href
  );
  implementations.unshift(["reference", baseline.runScan]);
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
]) {
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
  git("add", "-u");
  for (const [version, scan] of [...implementations]) {
    for (let i = -1; i < 5; i++) {
      const jobs = [];
      const start = performance.now();
      const report = await scan({
        repositoryRoot: root,
        cache: false,
        sourceExcerpts: "exclude",
        onEvent: (e) => {
          if (e.type === "check-running") jobs.push(e.checkId);
        },
      });
      if (i >= 0)
        samples.push({
          scenario,
          version,
          sample: i,
          elapsedMs: performance.now() - start,
          durationMs: report.durationMs,
          outcome: report.outcome,
          jobs,
        });
    }
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
      jobs: s[0].jobs,
      outcomes: [...new Set(s.map((s) => s.outcome))],
    });
  }
const result = {
  node: process.version,
  platform: process.platform,
  cache: false,
  warmup: 1,
  samples,
  summaries,
};
await (
  await import("node:fs/promises")
).rm(base, { recursive: true, force: true });
console.log(JSON.stringify(result, null, 2));
