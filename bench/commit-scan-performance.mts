import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir, loadavg } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execa } from "execa";

export interface CommitBenchmarkOptions {
  cli: string;
  repository: string;
  baseline: string;
  target: string;
  comparison?: "commit" | "merge";
  output: string;
  execution: "local" | "service";
  cache: "uncached" | "fresh" | "warm";
  samples: number;
  processSampling: boolean;
  loadLabel: "idle" | "controlled";
}
export function parseBenchmarkArguments(
  args: readonly string[],
): CommitBenchmarkOptions {
  const fields = new Map<string, string>();
  const allowed = [
    "cli",
    "repository",
    "baseline",
    "target",
    "comparison",
    "output",
    "execution",
    "cache",
    "samples",
    "process-sampling",
    "load-label",
  ];
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.replace(/^--/u, "");
    const value = args[i + 1];
    if (
      !args[i]?.startsWith("--") ||
      !key ||
      !allowed.includes(key) ||
      !value ||
      value.startsWith("--") ||
      fields.has(key)
    )
      throw Error("Expected unique --option value benchmark arguments.");
    fields.set(key, value);
  }
  for (const key of ["cli", "repository", "baseline", "target", "output"])
    if (!fields.has(key)) throw Error(`Missing benchmark option: ${key}`);
  const comparison = fields.get("comparison") ?? "commit";
  const execution = fields.get("execution") ?? "local",
    cache = fields.get("cache") ?? "fresh";
  const samples = Number(fields.get("samples") ?? "3"),
    sampling = fields.get("process-sampling") ?? "on",
    loadLabel = fields.get("load-label") ?? "idle";
  if (
    !["commit", "merge"].includes(comparison) ||
    !["local", "service"].includes(execution) ||
    !["uncached", "fresh", "warm"].includes(cache) ||
    !Number.isSafeInteger(samples) ||
    samples < 1 ||
    samples > 50 ||
    !["on", "off"].includes(sampling) ||
    !["idle", "controlled"].includes(loadLabel)
  )
    throw Error("Invalid benchmark mode or sample count.");
  return {
    cli: resolve(fields.get("cli")!),
    repository: resolve(fields.get("repository")!),
    baseline: fields.get("baseline")!,
    target: fields.get("target")!,
    output: resolve(fields.get("output")!),
    comparison: comparison === "merge" ? "merge" : "commit",
    execution: execution as CommitBenchmarkOptions["execution"],
    cache: cache as CommitBenchmarkOptions["cache"],
    samples,
    processSampling: sampling === "on",
    loadLabel: loadLabel as CommitBenchmarkOptions["loadLabel"],
  };
}
function within(root: string, path: string): boolean {
  const part = relative(root, path);
  return (
    part === "" ||
    (!isAbsolute(part) && part !== ".." && !part.startsWith(`..${sep}`))
  );
}
async function installationDigest(root: string): Promise<string> {
  const hash = createHash("sha256");
  hash.update(await readFile(join(root, "package.json")));
  const walk = async (directory: string) => {
    for (const entry of (
      await readdir(directory, { withFileTypes: true })
    ).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) {
        hash.update(relative(root, path));
        hash.update(await readFile(path));
      } else
        throw Error("Benchmark installation contains unsupported entries.");
    }
  };
  await walk(join(root, "dist"));
  return hash.digest("hex");
}
interface ProcessRow {
  pid: number;
  parent: number;
  role: "node" | "git" | "npm" | "yarn" | "pnpm" | "bun" | "other";
}
async function ownedProcesses(roots: readonly number[]): Promise<ProcessRow[]> {
  if (process.platform === "win32") return [];
  // Read executable identity only, never command arguments or environment.
  const result = await execa("ps", ["-axo", "pid=,ppid=,comm="], {
    reject: false,
    timeout: 2000,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.exitCode !== 0)
    throw Error("Owned process sampling is unavailable.");
  const all = result.stdout.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/u.exec(line);
    if (!match) return [];
    const name = basename(match[3]!).replace(/[()]/gu, "");
    const role = (
      ["node", "git", "npm", "yarn", "pnpm", "bun"].includes(name)
        ? name
        : "other"
    ) as ProcessRow["role"];
    return [{ pid: Number(match[1]), parent: Number(match[2]), role }];
  });
  const selected = new Set(roots),
    rows: ProcessRow[] = [];
  for (let round = 0; round < 64; round++) {
    let added = false;
    for (const row of all)
      if (!selected.has(row.pid) && selected.has(row.parent)) {
        selected.add(row.pid);
        rows.push(row);
        added = true;
      }
    if (!added) break;
  }
  return rows.slice(0, 4096);
}
async function validateBenchmarkFixture(options: CommitBenchmarkOptions) {
  const cli = await realpath(options.cli),
    repository = await realpath(options.repository),
    installation = dirname(dirname(cli));
  const requestedOutput = resolve(options.output);
  const output = join(
    await realpath(dirname(requestedOutput)),
    basename(requestedOutput),
  );
  if (within(repository, output) || within(installation, output))
    throw Error(
      "Benchmark output must be outside the measured repository and CLI installation.",
    );
  const git = async (args: string[]) => {
    const r = await execa("git", args, {
      cwd: repository,
      reject: false,
      stdin: "ignore",
    });
    if (r.exitCode !== 0)
      throw Error("Benchmark Git identity validation failed.");
    return r.stdout;
  };
  const baseline = await git([
      "rev-parse",
      "--verify",
      `${options.baseline}^{commit}`,
    ]),
    target = await git(["rev-parse", "--verify", `${options.target}^{commit}`]);
  if ((await git(["rev-parse", "HEAD"])) !== baseline)
    throw Error(
      "The disposable repository HEAD must be the requested baseline.",
    );
  await git(["diff", "--cached", "--quiet", target, "--"]);
  const comparison = options.comparison ?? "commit";
  const parents = (await git(["show", "-s", "--format=%P", target])).split(" ");
  if (comparison === "merge" && (parents.length < 2 || parents[0] !== baseline))
    throw Error(
      "The target must be a merge commit whose first parent is the baseline.",
    );
  const mergeHeadPath = resolve(
    repository,
    await git(["rev-parse", "--git-path", "MERGE_HEAD"]),
  );
  const noMergeHead = async () => {
    try {
      await readFile(mergeHeadPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    throw Error("The benchmark checkout must have no active merge.");
  };
  await noMergeHead();
  const comparisonParents = comparison === "merge" ? parents : [baseline];
  const parentPaths = await Promise.all(
    comparisonParents.map(async (parent) =>
      (await git(["diff", "--name-only", "-z", parent, target, "--"]))
        .split("\0")
        .filter(Boolean),
    ),
  );
  const indexBefore = await git(["diff", "--cached", "--raw"]);
  return {
    cli,
    repository,
    installation,
    output,
    git,
    baseline,
    target,
    comparison,
    parents,
    noMergeHead,
    comparisonParents,
    parentPaths,
    indexBefore,
  };
}

async function runBenchmarkSample(
  label: string,
  {
    options,
    invoke,
    stop,
    cacheRoot,
    sourceFreeMessages,
    comparison,
    comparisonParents,
    output,
  }: {
    options: CommitBenchmarkOptions;
    invoke: (
      args: string[],
      scan?: boolean,
    ) => Promise<{
      stdout: string;
      stderr: string;
      exitCode?: number | undefined;
    }> & { pid?: number | undefined };
    stop: () => Promise<void>;
    cacheRoot: string;
    sourceFreeMessages: boolean;
    comparison: "commit" | "merge";
    comparisonParents: readonly string[];
    output: string;
  },
) {
  if (options.cache !== "warm") {
    await stop();
    await rm(cacheRoot, { recursive: true, force: true });
  }
  const args = [
    "scan",
    "--hook-invocation",
    ...(comparison === "merge" ? ["--merge"] : []),
    "--format",
    "json",
    "--diagnostics",
    "--no-source",
    ...(sourceFreeMessages ? ["--diagnostic-messages", "source-free"] : []),
    "--no-color",
    ...(options.execution === "local" ? ["--no-service"] : []),
    ...(options.cache === "uncached" ? ["--no-cache"] : []),
  ];
  const roots: number[] = [];
  let serviceOwnershipKnown = options.execution !== "service";
  if (options.execution === "service") {
    try {
      const status = JSON.parse(
        (await invoke(["service", "status", "--format", "json"])).stdout,
      );
      if (status.state === "running" && Number.isSafeInteger(status.pid)) {
        roots.push(status.pid);
        serviceOwnershipKnown = true;
      }
    } catch {
      /* A stopped service has no seed. */
    }
  }
  const processes = new Map<string, ProcessRow>();
  let pending: Promise<void> | undefined,
    partial =
      process.platform === "win32" ||
      !options.processSampling ||
      !serviceOwnershipKnown;
  const observe = () => {
    if (pending) return;
    pending = ownedProcesses(roots)
      .then((rows) => {
        for (const row of rows) {
          if (processes.size >= 4096) {
            partial = true;
            break;
          }
          processes.set(`${row.pid}:${row.parent}:${row.role}`, row);
        }
      })
      .catch(() => {
        partial = true;
      })
      .finally(() => {
        pending = undefined;
      });
  };
  const started = performance.now(),
    child = invoke(args, true);
  if (child.pid !== undefined) roots.push(child.pid);
  const timer = options.processSampling
    ? setInterval(observe, 1000)
    : undefined;
  if (options.processSampling) observe();
  let result: Awaited<typeof child>;
  let finished = started;
  try {
    result = await child;
    finished = performance.now();
  } finally {
    if (timer) clearInterval(timer);
    await pending;
  }
  const wallMs = finished - started;
  let report: {
    durationMs?: number;
    outcome?: string;
    checks?: { status?: string }[];
    mergeParents?: string[];
  };
  try {
    report = JSON.parse(result.stdout);
  } catch {
    throw Error("Selected CLI did not produce a canonical JSON report.");
  }
  if (
    !["pass", "blocked", "incomplete"].includes(report.outcome ?? "") ||
    !Array.isArray(report.checks)
  )
    throw Error("Invalid benchmark scan report.");
  if (
    (comparison === "merge" &&
      JSON.stringify(report.mergeParents) !==
        JSON.stringify(comparisonParents)) ||
    (comparison === "commit" && report.mergeParents !== undefined)
  ) {
    throw Error("Benchmark scan selected the wrong comparison parents.");
  }
  await writeFile(join(output, `${label}.json`), result.stdout);
  await writeFile(join(output, `${label}-diagnostics.txt`), result.stderr);
  return {
    wallMs,
    scanMs: typeof report.durationMs === "number" ? report.durationMs : null,
    exitCode: result.exitCode ?? null,
    outcome: report.outcome!,
    completedChecks: report.checks.filter(
      (check) => check.status === "completed",
    ).length,
    incompleteChecks: report.checks.filter(
      (check) => check.status === "incomplete",
    ).length,
    processes: [...processes.values()],
    processSamplingPartial: partial,
  };
}

export async function runCommitScanBenchmark(options: CommitBenchmarkOptions) {
  const startedAt = new Date().toISOString();
  const {
    cli,
    repository,
    installation,
    output,
    git,
    baseline,
    target,
    comparison,
    parents,
    noMergeHead,
    comparisonParents,
    parentPaths,
    indexBefore,
  } = await validateBenchmarkFixture(options);
  const digest = await installationDigest(installation);
  const manifest = JSON.parse(
    await readFile(join(installation, "package.json"), "utf8"),
  ) as { version?: unknown };
  if (typeof manifest.version !== "string" || manifest.version.length > 64)
    throw Error("Invalid CLI installation metadata.");
  await mkdir(output, { mode: 0o700 }); // Refuse to overwrite any earlier experiment.
  const runtime = await mkdtemp(
    join(process.platform === "darwin" ? "/private/tmp" : tmpdir(), "zcp-"),
  );
  const env = {
    ...process.env,
    NODE_OPTIONS: "",
    ZEDBEE_TELEMETRY_DISABLED: "1",
    ZEDBEE_NO_UPDATE_CHECK: "1",
    TMPDIR: runtime,
    TMP: runtime,
    TEMP: runtime,
    XDG_CACHE_HOME: join(runtime, "cache"),
  };
  for (const key of Object.keys(env))
    if (key.startsWith("GITHEAD_")) delete env[key as keyof typeof env];
  const invoke = (args: string[], scan = false) =>
    execa(process.execPath, [cli, ...args], {
      cwd: repository,
      extendEnv: false,
      env:
        scan && comparison === "merge"
          ? {
              ...env,
              ...Object.fromEntries(
                parents.slice(1).map((parent) => [`GITHEAD_${parent}`, parent]),
              ),
            }
          : env,
      reject: false,
      stdin: "ignore",
      timeout: 600_000,
      maxBuffer: 128 * 1024 * 1024,
      killDescendants: true,
    });
  const stop = async () => {
    if (options.execution === "service") {
      const result = await invoke(["service", "stop"]);
      if (result.exitCode !== 0)
        throw Error("Benchmark service cleanup failed.");
    }
  };
  const samples: {
    wallMs: number;
    scanMs: number | null;
    exitCode: number | null;
    outcome: string;
    completedChecks: number;
    incompleteChecks: number;
    processes: ProcessRow[];
    processSamplingPartial: boolean;
  }[] = [];
  try {
    const help = await invoke(["scan", "--help"]);
    if (help.exitCode !== 0)
      throw Error("The selected CLI installation could not start.");
    const sourceFreeMessages = help.stdout.includes("--diagnostic-messages");
    if (options.cache === "uncached" && !help.stdout.includes("--no-cache"))
      throw Error(
        "This CLI installation does not support uncached CLI measurements; use fresh/warm mode for the historical reference.",
      );
    const run = (label: string) =>
      runBenchmarkSample(label, {
        options,
        invoke,
        stop,
        cacheRoot: env.XDG_CACHE_HOME,
        sourceFreeMessages,
        comparison,
        comparisonParents,
        output,
      });
    if (options.cache === "warm") await run("prime");
    for (let i = 0; i < options.samples; i++)
      samples.push(await run(`sample-${i + 1}`));
    if (
      (await git(["rev-parse", "HEAD"])) !== baseline ||
      (await git(["diff", "--cached", "--raw"])) !== indexBefore ||
      (await installationDigest(installation)) !== digest
    )
      throw Error(
        "Benchmark source/index or installation changed during measurement; discard this run.",
      );
    await noMergeHead();
    const ordered = samples.map((x) => x.wallMs).sort((a, b) => a - b),
      middle = Math.floor(ordered.length / 2);
    const result = {
      schemaVersion: 1,
      runKind: "commit-scan-performance",
      driverPid: process.pid,
      startedAt,
      finishedAt: new Date().toISOString(),
      version: manifest.version,
      installationDigest: digest,
      baseline,
      target,
      runtime: { node: process.version, platform: process.platform },
      comparison,
      parentChangedPathCounts: parentPaths.map((paths) => paths.length),
      unionChangedPathCount: new Set(parentPaths.flat()).size,
      execution: options.execution,
      cache: options.cache,
      loadLabel: options.loadLabel,
      diagnosticMessages: sourceFreeMessages
        ? "source-free"
        : "historical-default",
      loadAverageAtEnd: loadavg(),
      samples,
      medianWallMs:
        ordered.length % 2
          ? ordered[middle]!
          : (ordered[middle - 1]! + ordered[middle]!) / 2,
      limitations:
        "Worker and elapsed timings are wall time, not CPU. Warm cache does not guarantee warm engines. Process sampling can miss short-lived or reparented processes; roles contain executable basenames only. Results are private measurement evidence, not a regression verdict.",
    };
    await writeFile(
      join(output, "measurements.json"),
      JSON.stringify(result, null, 2) + "\n",
    );
    return result;
  } finally {
    await stop();
    await rm(runtime, { recursive: true, force: true });
  }
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const result = await runCommitScanBenchmark(
      parseBenchmarkArguments(process.argv.slice(2)),
    );
    console.log(
      JSON.stringify({
        samples: result.samples.length,
        medianWallMs: result.medianWallMs,
        version: result.version,
      }),
    );
  } catch {
    console.error(
      "Commit scan benchmark failed; verify the explicit installation, disposable comparison and output directory.",
    );
    process.exitCode = 1;
  }
}
