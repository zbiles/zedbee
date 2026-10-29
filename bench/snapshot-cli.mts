import { cp, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type * as Harness from "./cli-harness.mjs";
import type * as Memory from "./snapshot-memory.mjs";
const { runCompleteCli } = (await import(
  new URL("./cli-harness.mts", import.meta.url).href
)) as typeof Harness;
const { sampleProcessTree } = (await import(
  new URL("./snapshot-memory.mts", import.meta.url).href
)) as typeof Memory;

export type CacheMode = "off" | "cold" | "warm";
export type ExecutorMode = "local" | "cold-service" | "warm-service";

function decision(report: any) {
  return {
    mode: report.mode,
    baseline: report.baseline,
    target: report.target,
    changedFileCount: report.changedFileCount,
    outcome: report.outcome,
    exitCode: report.exitCode,
    checks: report.checks.map(
      ({ durationMs: _duration, ...check }: any) => check,
    ),
  };
}

/** All setup/priming is outside the timer; each call owns its service install. */
export async function measureCli(options: {
  implementationRoot: string;
  repositoryRoot: string;
  sampleRoot: string;
  cache: CacheMode;
  executor: ExecutorMode;
}) {
  const install = join(options.sampleRoot, "installation");
  const observations = join(options.sampleRoot, "observed.json");
  const cache = join(options.sampleRoot, "cache");
  await mkdir(install, { recursive: true });
  // Physical copies keep the installation identity checks intact. Dependencies
  // come from the lockfile install; benchmark setup is outside measured time.
  await cp(join(options.implementationRoot, "dist"), join(install, "dist"), {
    recursive: true,
  });
  await cp(
    join(options.implementationRoot, "package.json"),
    join(install, "package.json"),
  );
  // Resolving runtime dependencies via a link is valid here; the prebuilt dist
  // already contains the physically verified vendored files.
  const { symlink } = await import("node:fs/promises");
  await symlink(
    join(options.implementationRoot, "node_modules"),
    join(install, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const client = await import(
    pathToFileURL(join(install, "dist/service/client.js")).href
  );
  const { serviceLocation, serviceIdentity } = await import(
    pathToFileURL(join(install, "dist/service/identity.js")).href
  );
  const location = await serviceLocation();
  const identity = await serviceIdentity();
  if ((await client.serviceStatus()).state !== "stopped")
    throw new Error("Sample service namespace was not empty");
  const memory = sampleProcessTree();
  const run = () =>
    runCompleteCli({
      repositoryRoot: options.repositoryRoot,
      cliPath: join(install, "dist/cli.js"),
      args: [
        "scan",
        "--format",
        "json",
        "--no-source",
        ...(options.executor === "local" ? ["--no-service"] : []),
      ],
      env: {
        XDG_CACHE_HOME: cache,
        ZEDBEE_TELEMETRY_DISABLED: "1",
        ZEDBEE_BENCH_IMPLEMENTATION: install,
        ZEDBEE_BENCH_OBSERVATIONS: observations,
        ZEDBEE_BENCH_CACHE: options.cache,
        // runCompleteCli clears NODE_OPTIONS; pass the observer as an explicit
        // Node argument using the harness's nodeArguments option below.
      },
      nodeArguments: [
        "--import",
        fileURLToPath(new URL("./snapshot-observer.mjs", import.meta.url)),
      ],
      onSpawn: memory.add,
    });
  let primedPid: number | undefined;
  try {
    if (options.executor === "warm-service" || options.cache === "warm") {
      await run();
      const state = await client.serviceStatus();
      if (options.executor === "warm-service") {
        if (state.state !== "running")
          throw new Error("Warm service did not start");
        primedPid = state.pid;
        memory.add(state.pid);
      } else if (options.executor === "cold-service")
        await client.stopService();
      if (options.cache !== "warm")
        await rm(cache, { recursive: true, force: true });
    }
    const before = await client.serviceStatus();
    if (options.executor === "cold-service" && before.state !== "stopped")
      throw new Error("Cold service already running");
    const result = await run();
    const observed = JSON.parse(await readFile(observations, "utf8"));
    const report = JSON.parse(result.stdout);
    if (
      report.outcome !== "pass" ||
      !report.checks.some(
        (check: any) =>
          check.checkId === "types" && check.status === "completed",
      )
    )
      throw new Error("CLI sample did not execute required checks");
    if (
      observed.gets === 0 ||
      (options.cache === "warm" ? observed.hits === 0 : observed.hits !== 0)
    )
      throw new Error("Declared cache mode was not exercised");
    const after = await client.serviceStatus();
    if (options.executor === "local") {
      if (observed.serviceSessions !== 0 || after.state !== "stopped")
        throw new Error("Local sample used a service");
    } else {
      if (observed.serviceSessions === 0 || after.state !== "running")
        throw new Error("Service sample fell back to local");
      if (primedPid !== undefined && after.pid !== primedPid)
        throw new Error("Warm service was not reused");
      const { ServiceState } = await import(
        pathToFileURL(join(install, "dist/service/state.js")).href
      );
      const record = await new ServiceState(location.directory).read();
      if (record?.identity !== identity.content)
        throw new Error("Service build identity mismatch");
    }
    if (after.state === "running") memory.add(after.pid);
    const serviceTreeMemory = await memory.stop();
    return {
      durationMs: result.durationMs,
      observed,
      decision: decision(report),
      service: after,
      cacheMode: options.cache,
      executorMode: options.executor,
      serviceTreeMemory,
    };
  } finally {
    await memory.stop();
    if ((await client.stopService()).state !== "stopped")
      throw new Error("Sample-owned service did not stop");
    await rm(options.sampleRoot, { recursive: true, force: true });
  }
}
