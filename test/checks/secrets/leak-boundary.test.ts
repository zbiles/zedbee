import { mkdir, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { CheckRunContext } from "../../../src/checks/adapter.js";
import { observationCheckResult } from "../../../src/checks/observation-result.js";
import { secretsAdapter } from "../../../src/checks/secrets/adapter.js";
import { resolveConfig } from "../../../src/config/profiles.js";
import type { ChangeSet, ChangedFile } from "../../../src/git/change-set.js";
import { inspectRepository } from "../../../src/inspection/inspect-repository.js";
import { renderJson } from "../../../src/renderers/json.js";
import { renderText } from "../../../src/renderers/text.js";
import { enrichSourceExcerpts } from "../../../src/scan/source-excerpts.js";
import { createInspectionFixture } from "../../inspection/fixture.js";
import { createReport } from "../../helpers/scan-report.js";
import { testFilePolicyResolver } from "../../helpers/file-policy.js";

async function context(file: ChangedFile): Promise<CheckRunContext> {
  const [baseline, target, live] = await Promise.all([
    createInspectionFixture(),
    createInspectionFixture(),
    createInspectionFixture(),
  ]);
  for (const fixture of [baseline, target, live]) {
    await fixture.writeJson("package.json", { name: "fixture" });
    await mkdir(`${fixture.root}/src`, { recursive: true });
  }
  const changeSet: ChangeSet = {
    files: new Map([[file.path, file]]),
    isEmpty: false,
    containsAddedLine: (path, line) =>
      path === file.path &&
      file.addedRanges.some((range) => line >= range.start && line <= range.end),
  };
  const config = resolveConfig({ schemaVersion: 1, profile: "recommended" });
  return {
    repositoryRoot: live.root,
    changeSet,
    config,
    snapshots: {
      baselineDir: baseline.root,
      targetDir: target.root,
      baselineRef: "HEAD",
      targetRef: "index",
      unsupportedEntries: [],
    },
    baselineInspection: await inspectRepository(baseline.root),
    targetInspection: await inspectRepository(target.root),
    target: { id: ".", kind: "repository", relativeRoot: "." },
    policy: config.checks.secrets,
    policyForFile: testFilePolicyResolver(config),
    signal: new AbortController().signal,
  };
}

function representativeSecrets() {
  const aws = "Q".repeat(40);
  const github = `ghp_${"g".repeat(36)}`;
  const npm = `npm_${"n".repeat(36)}`;
  const openai = `sk-${"o".repeat(20)}T3BlbkFJ${"p".repeat(20)}`;
  const anthropic = `sk-ant-api03-${"a".repeat(93)}AA`;
  const privateKeyPayload = `MI${"K".repeat(118)}`;
  const databasePassword = "RealDatabasePassword947";
  return {
    source: [
      `AWS_SECRET_ACCESS_KEY=${aws}`,
      `GITHUB_TOKEN=${github}`,
      `NPM_TOKEN=${npm}`,
      `OPENAI_API_KEY=${openai}`,
      `ANTHROPIC_API_KEY=${anthropic}`,
      "PRIVATE_KEY=-----BEGIN PRIVATE KEY-----",
      privateKeyPayload,
      "-----END PRIVATE KEY-----",
      `DATABASE_URL=postgres://realuser:${databasePassword}@db.internal/prod`,
      "",
    ].join("\n"),
    canaries: [
      aws,
      github,
      npm,
      openai,
      anthropic,
      privateKeyPayload,
      databasePassword,
    ],
  };
}

describe("Secretlint leak boundary", () => {
  it("detects representative credential classes without exposing secret bytes", async () => {
    const { source, canaries } = representativeSecrets();
    const run = await context({
      path: "src/secrets.env",
      status: "added",
      addedRanges: [{ start: 1, end: source.split("\n").length }],
    });
    await writeFile(`${run.snapshots.targetDir}/src/secrets.env`, source);
    run.targetInspection = await inspectRepository(run.snapshots.targetDir);

    const collected = await secretsAdapter.collect(run);
    const ruleIds = new Set(
      collected.targetObservations.map((observation) => observation.rule),
    );
    for (const expected of [
      "secretlint-rule-aws",
      "secretlint-rule-github",
      "secretlint-rule-npm",
      "secretlint-rule-openai",
      "secretlint-rule-anthropic",
      "secretlint-rule-privatekey",
      "secretlint-rule-database-connection-string",
    ]) {
      expect([...ruleIds].some((rule) => rule.includes(expected))).toBe(true);
    }

    const check = await observationCheckResult("secrets", collected, run, true);
    const [reportedCheck] = await enrichSourceExcerpts(
      [check],
      run.targetInspection,
    );
    expect(reportedCheck?.findings.length).toBeGreaterThanOrEqual(7);
    expect(
      reportedCheck?.findings.every(
        (finding) =>
          finding.sourceExcerpt?.redacted === true &&
          finding.sourceExcerpt.text === undefined,
      ),
    ).toBe(true);

    const report = createReport({
      outcome: "blocked",
      exitCode: 1,
      checks: [reportedCheck!],
      summary: {
        passed: 0,
        warnings: 0,
        failed: 1,
        incomplete: 0,
        findings: reportedCheck!.findings,
      },
    });
    const event = {
      type: "check-completed",
      checkId: "secrets",
      target: ".",
      timestamp: 1,
      result: reportedCheck,
    };
    const React = await import("react");
    const { render } = await import("ink-testing-library");
    const { FindingsList } = await import("../../../src/ui/findings-list.js");
    const ink = render(
      React.createElement(FindingsList, {
        findings: reportedCheck!.findings,
        width: 100,
        color: false,
      }),
    ).lastFrame()!;
    const publicSurfaces = [
      JSON.stringify(collected),
      JSON.stringify(event),
      renderJson(report),
      renderText(report, { width: 100, color: false }),
      ink,
    ];
    for (const canary of canaries) {
      for (const surface of publicSurfaces) {
        expect(surface).not.toContain(canary);
      }
    }
  });
});
