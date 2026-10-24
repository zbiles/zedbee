import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { captureEnvironment } from "../../bench/report.mjs";
import {
  compareBenchmarkReports,
  selectPerformanceBase,
} from "../../bench/compare.mjs";
import {
  assertPerformanceEvidence,
  verificationSteps,
} from "../../scripts/release-check.mjs";

function report(commit = "a".repeat(40), coldMs = 1_000, warmMs = 500) {
  return {
    schemaVersion: 1,
    kind: "within-session-phase-comparison",
    environment: {
      ...captureEnvironment(process.cwd(), {}),
      commit,
      workingTreeDirty: false,
    },
    fixtures: { small: { inspection: { coldMs, warmMs } } },
  };
}

it("runs correctness benchmarks without an archived environment baseline", () => {
  expect(
    verificationSteps("verify").find(({ id }) => id === "benchmark")?.args,
  ).toContain("--smoke");
  expect(
    verificationSteps("release").find(({ id }) => id === "benchmark")?.args,
  ).toContain("--smoke");
});

it("requires separate successful performance evidence for publication", () => {
  expect(() => assertPerformanceEvidence({})).toThrow(/performance/i);
  expect(() =>
    assertPerformanceEvidence({ ZEDBEE_PERFORMANCE_EVIDENCE: "smoke" }),
  ).toThrow(/performance/i);
  expect(() =>
    assertPerformanceEvidence({ ZEDBEE_PERFORMANCE_EVIDENCE: "verified" }),
  ).not.toThrow();
});

it("compares real same-environment reports using both regression thresholds", () => {
  const base = report();
  const head = {
    ...report("b".repeat(40), 1_251, 750),
    environment: { ...base.environment, commit: "b".repeat(40) },
  };
  const result = compareBenchmarkReports(base, head);
  expect(result.status).toBe("regression");
  expect(result.regressions).toEqual([
    {
      fixture: "small",
      phase: "inspection",
      metric: "coldMs",
      baseMs: 1_000,
      headMs: 1_251,
    },
  ]);
  expect(result.comparedMetrics).toBe(2);
  expect(
    compareBenchmarkReports(base, {
      ...head,
      fixtures: { small: { inspection: { coldMs: 1_250, warmMs: 750 } } },
    }).status,
  ).toBe("passed");
});

it("reports added and removed phases as unavailable while gating common phases", () => {
  const base = report();
  const head = {
    ...report("b".repeat(40)),
    environment: { ...base.environment, commit: "b".repeat(40) },
    fixtures: {
      small: {
        inspection: { coldMs: 900, warmMs: 400 },
        rendering: { coldMs: 20, warmMs: 10 },
      },
    },
  };
  const result = compareBenchmarkReports(base, head);
  expect(result.status).toBe("passed");
  expect(result.unavailable).toContain("small/rendering: absent from base");
  expect(compareBenchmarkReports(head, base).unavailable).toContain(
    "small/rendering: absent from head",
  );
});

it("does not pass missing, incompatible, or same-commit comparisons", () => {
  const base = report();
  const head = {
    ...report("b".repeat(40)),
    environment: { ...base.environment, commit: "b".repeat(40) },
  };
  expect(compareBenchmarkReports(base, base).status).toBe("unavailable");
  expect(
    compareBenchmarkReports(base, {
      ...head,
      environment: { ...head.environment, node: "v99.0.0" },
    }).status,
  ).toBe("unavailable");
  expect(
    compareBenchmarkReports(base, { ...head, kind: "old-harness" }).status,
  ).toBe("unavailable");
  expect(
    compareBenchmarkReports(base, { ...head, environment: undefined }).status,
  ).toBe("unavailable");
  expect(
    compareBenchmarkReports(base, {
      ...head,
      fixtures: { small: { rendering: { coldMs: 1, warmMs: 1 } } },
    }).status,
  ).toBe("unavailable");
});

it.each([NaN, -1, Infinity, "2", null])(
  "rejects invalid measurements: %s",
  (coldMs) => {
    const base = report();
    const head = {
      ...report("b".repeat(40)),
      fixtures: { small: { inspection: { coldMs, warmMs: 10 } } },
    };
    expect(() => compareBenchmarkReports(base, head)).toThrow(/measurement/i);
  },
);

it("selects the previous reachable release and falls back to the first parent for an initial release", async () => {
  const root = await mkdtemp(join(tmpdir(), "zedbee-perf-base-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  try {
    git("init", "--initial-branch=main");
    git("config", "user.name", "Test");
    git("config", "user.email", "test@example.invalid");
    await writeFile(join(root, "fixture"), "first");
    git("add", ".");
    git("commit", "-m", "first");
    expect(() => selectPerformanceBase(root)).toThrow(/unavailable/i);
    const first = git("rev-parse", "HEAD");
    await writeFile(join(root, "fixture"), "second");
    git("commit", "-am", "second");
    expect(selectPerformanceBase(root)).toBe(first);
    git("tag", "v0.1.0");
    const previousRelease = git("rev-parse", "HEAD");
    await writeFile(join(root, "fixture"), "third");
    git("commit", "-am", "third");
    await writeFile(join(root, "fixture"), "fourth");
    git("commit", "-am", "fourth");
    git("tag", "v0.2.0");
    expect(selectPerformanceBase(root)).toBe(previousRelease);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("measures both checkouts, preserves raw reports, and exits unsuccessfully on a regression", async () => {
  const root = await mkdtemp(join(tmpdir(), "zedbee-perf-cli-"));
  try {
    const base = report();
    const head = {
      ...report("b".repeat(40), 1_300),
      environment: { ...base.environment, commit: "b".repeat(40) },
    };
    for (const [name, measurement] of [
      ["base", base],
      ["head", head],
    ] as const) {
      await mkdir(join(root, name, "bench"), { recursive: true });
      await writeFile(
        join(root, name, "bench/run.mts"),
        `process.stdout.write(${JSON.stringify(JSON.stringify(measurement))});`,
      );
    }
    const output = join(root, "comparison.json");
    const result = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        fileURLToPath(new URL("../../bench/compare.mts", import.meta.url)),
        "--base-root",
        join(root, "base"),
        "--output",
        output,
      ],
      { cwd: join(root, "head"), encoding: "utf8" },
    );
    expect(result.status).toBe(1);
    expect(JSON.parse(await readFile(output, "utf8")).status).toBe(
      "regression",
    );
    expect(JSON.parse(await readFile(`${output}.base.json`, "utf8"))).toEqual(
      base,
    );
    expect(JSON.parse(await readFile(`${output}.head.json`, "utf8"))).toEqual(
      head,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("retains an unavailable report when an old revision cannot produce measurements", async () => {
  const root = await mkdtemp(join(tmpdir(), "zedbee-perf-unavailable-"));
  try {
    await mkdir(join(root, "base/bench"), { recursive: true });
    await mkdir(join(root, "head"));
    await writeFile(join(root, "base/bench/run.mts"), "process.exitCode = 1;");
    const output = join(root, "comparison.json");
    const result = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        fileURLToPath(new URL("../../bench/compare.mts", import.meta.url)),
        "--base-root",
        join(root, "base"),
        "--output",
        output,
      ],
      { cwd: join(root, "head"), encoding: "utf8" },
    );
    expect(result.status).toBe(1);
    const comparison = JSON.parse(await readFile(output, "utf8"));
    expect(comparison.status).toBe("unavailable");
    expect(comparison.unavailable.join(" ")).toContain(
      "base benchmark measurement failed",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
