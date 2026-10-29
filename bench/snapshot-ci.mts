import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { execa } from "execa";

const root = process.cwd();
const temporary = resolve(
  process.env.RUNNER_TEMP ?? process.env.TMPDIR ?? ".snapshot-ci",
);
const baseRoot = join(temporary, "zedbee-snapshot-baseline");
const output = join(temporary, "snapshot-performance.json");
const requestedBase = process.env.SNAPSHOT_BASELINE_REF;
if (!requestedBase)
  throw new Error("An explicit snapshot baseline ref is required");
const baseline = (
  await execa("git", [
    "rev-parse",
    "--verify",
    "--end-of-options",
    `${requestedBase}^{commit}`,
  ])
).stdout;
if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(baseline))
  throw new Error("Invalid baseline identity");
await mkdir(temporary, { recursive: true });
await execa("git", ["worktree", "add", "--detach", baseRoot, baseline]);
try {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  for (const cwd of [baseRoot, root]) {
    // The workflow installs HEAD before invoking this script (and loading its
    // dependencies); do not delete the running script's node_modules again.
    if (cwd === baseRoot)
      await execa(npm, ["ci", "--ignore-scripts"], { cwd, stdio: "inherit" });
    await execa(npm, ["run", "build"], { cwd, stdio: "inherit" });
  }
  await execa(
    process.execPath,
    [
      "--experimental-strip-types",
      "bench/snapshot-preparation.mts",
      "--baseline-root",
      baseRoot,
      "--implementation-root",
      root,
      "--kind",
      "preparation",
      "--sizes",
      "4000",
      "--scenarios",
      "json",
      "--output",
      output,
    ],
    { stdio: "inherit" },
  );
  await execa(
    process.execPath,
    ["--experimental-strip-types", "bench/snapshot-gates.mts", output],
    { stdio: "inherit" },
  );
} finally {
  await execa("git", ["worktree", "remove", "--force", baseRoot]);
}
