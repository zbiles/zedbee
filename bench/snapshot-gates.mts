import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

interface Sample {
  root: string;
  kind: string;
  count: number;
  scenario: string;
  sample: number;
  manifestHash: string;
  timings: { snapshots: number; total: number };
  peakRssBytes: number;
}

/** Primary 4,000-file gate only; this never certifies a full fixture/platform matrix. */
export function assessSnapshotPreparation(input: unknown) {
  const artifact = input as
    | {
        samples?: number;
        identities?: Array<{ root: string; dirty: string }>;
        results?: Sample[];
      }
    | undefined;
  if (
    artifact?.samples !== 15 ||
    artifact.identities?.length !== 2 ||
    !Array.isArray(artifact.results)
  )
    throw new Error("Missing paired benchmark evidence");
  const identities = artifact.identities;
  if (
    identities.some(
      (entry) =>
        typeof entry.root !== "string" ||
        entry.root === "" ||
        entry.dirty !== "",
    ) ||
    new Set(identities.map((entry) => entry.root)).size !== 2
  )
    throw new Error("Benchmark builds are not clean and distinct");
  const rows = artifact.results.filter(
    (row) =>
      row.kind === "preparation" &&
      row.count === 4000 &&
      row.scenario === "json",
  );
  if (
    rows.length !== 30 ||
    new Set(rows.map((row) => row.manifestHash)).size !== 1 ||
    !rows.every((row) => /^[a-f0-9]{64}$/u.test(row.manifestHash))
  )
    throw new Error("Missing or inconsistent primary fixtures");
  const median = (values: number[]) => [...values].sort((a, b) => a - b)[7]!;
  const summarize = (root: string) => {
    const samples = rows.filter((row) => row.root === root);
    if (
      samples.length !== 15 ||
      new Set(samples.map((row) => row.sample)).size !== 15 ||
      samples.some(
        (row) =>
          !Number.isInteger(row.sample) ||
          row.sample < 0 ||
          row.sample >= 15 ||
          ![row.timings?.snapshots, row.timings?.total, row.peakRssBytes].every(
            (value) => Number.isFinite(value) && value > 0,
          ),
      )
    )
      throw new Error("Invalid or incomplete paired samples");
    return {
      snapshots: median(samples.map((row) => row.timings.snapshots)),
      preparationMedian: median(samples.map((row) => row.timings.total)),
      preparationP95: Math.max(...samples.map((row) => row.timings.total)),
      peakRssBytes: Math.max(...samples.map((row) => row.peakRssBytes)),
      medianPeakRssBytes: median(samples.map((row) => row.peakRssBytes)),
    };
  };
  const baseline = summarize(identities[0]!.root);
  const candidate = summarize(identities[1]!.root);
  const failures: string[] = [];
  if (candidate.snapshots > baseline.snapshots * 0.75)
    failures.push("snapshot-speed");
  for (const [key, label] of [
    ["preparationMedian", "preparation-median"],
    ["preparationP95", "preparation-p95"],
  ] as const) {
    if (
      candidate[key] > baseline[key] * 1.1 &&
      candidate[key] - baseline[key] > 100
    )
      failures.push(label);
  }
  if (candidate.peakRssBytes - baseline.peakRssBytes > 16 * 1024 * 1024)
    failures.push("peak-memory");
  return {
    scope: "primary-4000-json-local-preparation",
    passed: failures.length === 0,
    failures,
    baseline,
    candidate,
    snapshotImprovementPercent:
      (1 - candidate.snapshots / baseline.snapshots) * 100,
    completeMatrixVerified: false,
  };
}

interface MatrixSample {
  root: string;
  kind: string;
  count: number;
  scenario: string;
  sample: number;
  manifestHash: string;
  timings?: { total: number; snapshots: number };
  peakRssBytes?: number;
  durationMs?: number;
  cacheMode?: string;
  executorMode?: string;
  observed?: { gets: number; hits: number; serviceSessions: number };
  service?: { state: string };
  serviceTreeMemory?: {
    verified: boolean;
    samples: number;
    intervalMs: number;
    peakRssBytes: number;
  };
  decision?: {
    outcome: string;
    exitCode: number;
    checks: Array<{ checkId: string; status: string }>;
  };
}

/** One isolated cell; complete-matrix coverage is assessed across its artifacts. */
export function assessSnapshotMatrixCell(input: unknown) {
  const data = input as {
    samples?: number;
    identities?: Array<{ root: string; dirty: string }>;
    results?: MatrixSample[];
  };
  if (
    data?.samples !== 15 ||
    data.identities?.length !== 2 ||
    data.results?.length !== 30
  )
    throw new Error("Missing paired matrix evidence");
  const identities = data.identities;
  if (
    identities.some(
      (i) => typeof i.root !== "string" || !i.root || i.dirty !== "",
    ) ||
    new Set(identities.map((i) => i.root)).size !== 2
  )
    throw new Error("Matrix builds are not clean and distinct");
  const rows = data.results;
  const first = rows[0]!;
  if (
    !["preparation", "cli"].includes(first.kind) ||
    ![100, 4000, 20000].includes(first.count) ||
    !["json", "ts", "config", "large"].includes(first.scenario)
  )
    throw new Error("Invalid matrix cell");
  const signature = (r: MatrixSample) =>
    JSON.stringify([r.kind, r.count, r.scenario, r.cacheMode, r.executorMode]);
  if (
    rows.some(
      (r) =>
        signature(r) !== signature(first) ||
        !/^[a-f0-9]{64}$/u.test(r.manifestHash),
    ) ||
    new Set(rows.map((r) => r.manifestHash)).size !== 1
  )
    throw new Error("Mixed or changed matrix fixtures");
  const paired = identities.map(({ root }) => {
    const selected = rows
      .filter((r) => r.root === root)
      .sort((a, b) => a.sample - b.sample);
    if (selected.length !== 15 || selected.some((r, i) => r.sample !== i))
      throw new Error("Missing or duplicated samples");
    return selected;
  });
  const positive = (n: unknown) =>
    typeof n === "number" && Number.isFinite(n) && n > 0;
  if (first.kind === "cli") {
    if (
      !["off", "cold", "warm"].includes(first.cacheMode ?? "") ||
      !["local", "cold-service", "warm-service"].includes(
        first.executorMode ?? "",
      )
    )
      throw new Error("Invalid execution mode");
    for (const r of rows) {
      const o = r.observed,
        m = r.serviceTreeMemory;
      if (
        !o ||
        !positive(o.gets) ||
        !Number.isInteger(o.hits) ||
        o.hits < 0 ||
        (r.cacheMode === "warm" ? o.hits === 0 : o.hits !== 0) ||
        (r.executorMode === "local"
          ? o.serviceSessions !== 0 || r.service?.state !== "stopped"
          : !positive(o.serviceSessions) || r.service?.state !== "running") ||
        !m?.verified ||
        !positive(m.samples) ||
        m.intervalMs !== 100 ||
        !positive(m.peakRssBytes)
      )
        throw new Error("Unverified matrix cache, service or memory evidence");
    }
  }
  const summarize = (samples: MatrixSample[]) => {
    const values = samples.map((r) =>
      first.kind === "preparation" ? r.timings?.total : r.durationMs,
    );
    if (!values.every(positive)) throw new Error("Invalid timings");
    const sorted = (values as number[]).sort((a, b) => a - b);
    return { median: sorted[7]!, p95: sorted[14]! };
  };
  const baseline = summarize(paired[0]!);
  const candidate = summarize(paired[1]!);
  const failures: string[] = [];
  for (const metric of ["median", "p95"] as const)
    if (
      candidate[metric] > baseline[metric] * 1.1 &&
      candidate[metric] - baseline[metric] > 100
    )
      failures.push(metric);
  if (first.kind === "cli") {
    if (
      paired[0]!.some(
        (r, i) =>
          JSON.stringify(r.decision) !==
          JSON.stringify(paired[1]![i]!.decision),
      )
    )
      failures.push("decision-parity");
    if (
      rows.some(
        (r) =>
          r.decision?.outcome !== "pass" ||
          r.decision.exitCode !== 0 ||
          !r.decision.checks?.some(
            (c) => c.checkId === "types" && c.status === "completed",
          ),
      )
    )
      failures.push("scan-outcome");
  } else {
    if (
      rows.some(
        (r) => !positive(r.timings?.snapshots) || !positive(r.peakRssBytes),
      )
    )
      throw new Error("Invalid preparation evidence");
    if (first.count === 4000 && first.scenario === "json")
      failures.push(...assessSnapshotPreparation(data).failures);
  }
  return {
    scope: "single-matrix-cell",
    passed: failures.length === 0,
    failures: [...new Set(failures)],
    baseline,
    candidate,
    cell: {
      kind: first.kind,
      count: first.count,
      scenario: first.scenario,
      cache: first.cacheMode,
      executor: first.executorMode,
    },
    completeMatrixVerified: false,
  };
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  const path = resolve(process.argv[2] ?? "");
  const assess = process.argv.includes("--matrix")
    ? assessSnapshotMatrixCell
    : assessSnapshotPreparation;
  const result = assess(JSON.parse(await readFile(path, "utf8")));
  await writeFile(`${path}.gates.json`, JSON.stringify(result, null, 2) + "\n");
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  if (!result.passed) process.exitCode = 1;
}
