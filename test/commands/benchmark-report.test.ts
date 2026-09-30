import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  captureEnvironment,
  renderBaselineReport,
  writeBaselineFiles,
} from "../../bench/report.mjs";

it("records the Actions run and runner image without copying unrelated environment data", () => {
  const environment = captureEnvironment(process.cwd(), {
    GITHUB_ACTIONS: "true",
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_REPOSITORY: "example/project",
    GITHUB_RUN_ID: "123",
    GITHUB_RUN_ATTEMPT: "2",
    GITHUB_JOB: "verify",
    RUNNER_ENVIRONMENT: "github-hosted",
    ZEDBEE_BENCHMARK_RUNNER: "ubuntu-latest",
    ImageOS: "ubuntu24",
    ImageVersion: "20260927.1.0",
    SECRET_TOKEN: "must-not-appear",
  });
  expect(environment.githubActions).toMatchObject({
    runUrl: "https://github.com/example/project/actions/runs/123/attempts/2",
    runnerLabel: "ubuntu-latest",
    image: "ubuntu24",
    imageVersion: "20260927.1.0",
  });
  expect(environment.node).toBe(process.version);
  expect(environment.platform).toBe(process.platform);
  expect(environment.commit).toMatch(/^[a-f0-9]{40}$/);
  expect(JSON.stringify(environment)).not.toContain("must-not-appear");
});

it("preserves measurement precision in JSON and writes a readable report from the same run", async () => {
  const root = await mkdtemp(join(tmpdir(), "zedbee-benchmark-report-"));
  try {
    const baseline = {
      schemaVersion: 1 as const,
      environment: captureEnvironment(process.cwd(), {}),
      fixtures: {
        small: {
          "adapter.lint.execute": { coldMs: 544.959, warmMs: 514.8498 },
        },
      },
    };
    await writeBaselineFiles(root, baseline);
    expect(
      JSON.parse(await readFile(join(root, "baselines.json"), "utf8")),
    ).toEqual(baseline);
    const report = await readFile(join(root, "README.md"), "utf8");
    expect(report).toContain("| Lint | 544.96 | 514.85 |");
    expect(report).toContain(process.version);
    expect(report).toContain(baseline.environment.commit!);
    expect(baseline.environment.githubActions).toBeNull();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("does not attribute historical measurements to the computer rendering the report", () => {
  const report = renderBaselineReport({ schemaVersion: 1, fixtures: {} });
  expect(report).toContain("Not recorded");
  expect(report).not.toContain(process.version);
});
