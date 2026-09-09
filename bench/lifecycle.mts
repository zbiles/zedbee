import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalAnalyzerExecutor, runScan } from "../dist/index.js";
import { acquireServiceExecutor, stopService } from "../dist/service/client.js";
import type { ScanReport } from "../dist/scan/report.js";
import type * as Harness from "./cli-harness.mjs";

const { runCompleteCli } = (await import(
  new URL("./cli-harness.mts", import.meta.url).href
)) as typeof Harness;

function diagnostics(report: ScanReport) {
  if (report.summary.incomplete > 0 || report.exitCode === 2)
    throw new Error(
      "Incomplete scans cannot supply a lifecycle benchmark sample.",
    );
  return report.checks.map(({ checkId, target, status, durationMs }) => ({
    checkId,
    target,
    status,
    durationMs,
  }));
}

/** Existing committed/staged fixture is read-only. No dependency or source mutation. */
export async function runLifecycleBenchmark(
  repositoryRoot: string,
  concurrency: 1 | 2 | 4,
  iterations: number,
) {
  if (!Number.isSafeInteger(iterations) || iterations < 1)
    throw new TypeError("Invalid lifecycle iteration count.");
  // Short names leave room for the native Unix socket path. This root is unique,
  // so stop and cleanup never target a user's existing analyzer service.
  const scratch = await realpath(await mkdtemp(join(tmpdir(), "zb-")));
  const priorTmp = {
    TMPDIR: process.env.TMPDIR,
    TMP: process.env.TMP,
    TEMP: process.env.TEMP,
  };
  Object.assign(process.env, { TMPDIR: scratch, TMP: scratch, TEMP: scratch });
  const env = { TMPDIR: scratch, TMP: scratch, TEMP: scratch };
  const scenarios: Record<string, unknown> = {};
  let cleanupProved = false;
  let completed = false;
  let uniqueCache = 0;
  const cliScan = async (cache: string, local = false) => {
    await mkdir(cache, { recursive: true });
    const result = await runCompleteCli({
      repositoryRoot,
      env: { ...env, XDG_CACHE_HOME: cache },
      args: [
        "scan",
        "--format",
        "json",
        "--diagnostics",
        ...(local ? ["--no-service"] : []),
      ],
    });
    const report = JSON.parse(result.stdout) as ScanReport;
    return {
      durationMs: result.durationMs,
      checks: diagnostics(report),
      commandDiagnostics: result.stderr,
    };
  };
  const samples = async (operation: () => Promise<unknown>) => {
    const rows = [];
    for (let i = 0; i < iterations; i++) rows.push(await operation());
    return rows;
  };
  try {
    scenarios["fresh-cli-local"] = {
      concurrency: 2,
      observationCache: "fresh directory per command",
      samples: await samples(() =>
        cliScan(join(scratch, `cache-${uniqueCache++}`), true),
      ),
    };
    const serviceStart = performance.now();
    const seed = await acquireServiceExecutor({ concurrency });
    await seed.close();
    scenarios["service-startup"] = {
      durationMs: performance.now() - serviceStart,
      note: "Service acquisition and seed connection cleanup; engine initialization is in the following primer.",
    };
    scenarios["service-engine-primer"] = await cliScan(
      join(scratch, `cache-${uniqueCache++}`),
    );
    scenarios["cross-command-engine-reuse-no-observation-hits"] = {
      concurrency,
      note: "Same service, distinct empty observation cache per command. Reuse-capable modules may survive; compiler-backed React retires its worker on session release.",
      samples: await samples(() =>
        cliScan(join(scratch, `cache-${uniqueCache++}`)),
      ),
    };
    const repeatCache = join(scratch, "observation-repeat");
    scenarios["observation-cache-primer"] = await cliScan(repeatCache);
    scenarios["observation-cache-repeat"] = {
      concurrency,
      note: "Same fixture and observation cache; ineligible checks still execute. Per-check durations are diagnostic, not proof of cache hits.",
      samples: await samples(() => cliScan(repeatCache)),
    };
    const executorStart = performance.now();
    const executor = createLocalAnalyzerExecutor({ concurrency });
    const apiSamples: unknown[] = [];
    try {
      for (let i = 0; i < iterations; i++) {
        const start = performance.now();
        const report = await runScan({
          repositoryRoot,
          executor,
          cache: false,
        });
        apiSamples.push({
          durationMs: performance.now() - start,
          checks: diagnostics(report),
        });
      }
    } finally {
      await executor.close();
    }
    scenarios["explicit-api-executor"] = {
      concurrency,
      observationCache: false,
      totalIncludingExecutorCreationAndCloseMs:
        performance.now() - executorStart,
      samples: apiSamples,
    };
    const stopStart = performance.now();
    const stopped = await stopService();
    if (stopped.state !== "stopped")
      throw new Error("Benchmark service cleanup could not be proved.");
    scenarios["service-stop"] = { durationMs: performance.now() - stopStart };
    cleanupProved = true;
    completed = true;
    return {
      schemaVersion: 2,
      kind: "complete-command-lifecycle",
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      iterations,
      scenarios,
      limitations:
        "No memory measurement. Per-engine diagnostics include scheduling and validation. Historical phase targets are unchanged; these results are separate from in-process references.",
    };
  } finally {
    try {
      if (!cleanupProved)
        cleanupProved = (await stopService()).state === "stopped";
    } finally {
      for (const [key, value] of Object.entries(priorTmp)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
    if (cleanupProved && completed) await rm(scratch, { recursive: true });
    else {
      process.stderr.write(
        `Benchmark did not complete; retained fixture data at ${scratch}\n`,
      );
      if (!cleanupProved)
        throw new Error("Benchmark service cleanup is unproved.");
    }
  }
}
