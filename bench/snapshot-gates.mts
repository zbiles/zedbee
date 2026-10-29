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

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  const path = resolve(process.argv[2] ?? "");
  const result = assessSnapshotPreparation(
    JSON.parse(await readFile(path, "utf8")),
  );
  await writeFile(`${path}.gates.json`, JSON.stringify(result, null, 2) + "\n");
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  if (!result.passed) process.exitCode = 1;
}
