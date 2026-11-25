import { chmod, mkdir, readFile, realpath, symlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToString } from "ink";
import { expect, it } from "vitest";
import { createReport } from "../helpers/scan-report.js";
import { createGitRepository } from "../helpers/git-repository.js";
import { HOOK_UPDATE_NOTICE } from "../../src/hooks/update-notice.js";
import { renderText } from "../../src/renderers/text.js";
import { renderJson } from "../../src/renderers/json.js";
import { renderSarif } from "../../src/renderers/sarif.js";
import { terminalCellWidth } from "../../src/renderers/terminal-cells.js";
import { ScanResultDashboard } from "../../src/ui/scan-result-dashboard.js";
import { defaultDiagnosticProbe } from "../../src/doctor/diagnostics.js";
import { GitClient } from "../../src/git/client.js";
import { resolveHookCommand } from "../../src/hooks/command.js";
import { executeScanCommand } from "../../src/commands/scan.js";
import { RECOMMENDED_AGENT_GUIDANCE } from "../../src/reporting/agent-guidance.js";

const presentation = {
  automatic: true,
  reportStatus: "available" as const,
  findings: [],
  totalFindingCount: 0,
  abbreviated: false,
  reportPath: "/private/tmp/zedbee-reports/review.json",
  warnings: [],
};

it.each([40, 80, 120])(
  "shows the setup notice after SCAN RESULT inside the %s-column frame",
  (width) => {
    const base = createReport();
    const report = {
      ...base,
      hookUpdate: HOOK_UPDATE_NOTICE,
      presentationPolicy: {
        ...base.presentationPolicy,
        agentGuidance: RECOMMENDED_AGENT_GUIDANCE,
      },
    };
    const output = renderToString(
      createElement(ScanResultDashboard, {
        report,
        presentation,
        width,
        color: false,
      }),
      { columns: width },
    );
    expect(output).toContain("HOOK UPDATE NEEDED");
    expect(output.indexOf("HOOK UPDATE NEEDED")).toBeGreaterThan(
      output.indexOf("SCAN RESULT"),
    );
    expect(output.indexOf("HOOK UPDATE NEEDED")).toBeLessThan(
      output.indexOf("NEXT STEPS"),
    );
    const noticeLine = output
      .split("\n")
      .find((line) => line.includes("HOOK UPDATE NEEDED"))!;
    expect(noticeLine.trim().startsWith("██")).toBe(true);
    expect(noticeLine.trim().endsWith("██")).toBe(true);
    expect(output).toContain("zedbee init");
    expect(output).toContain("AGENT NEXT STEP");
    expect(
      renderText(report, { width: 240, color: false, presentation }),
    ).toContain(
      "Recommend updating Swarm’s hooks and offer to run zedbee init for the user.",
    );
    expect(
      Math.max(...output.split("\n").map(terminalCellWidth)),
    ).toBeLessThanOrEqual(width);
    expect(report.exitCode).toBe(0);
    expect(report.summary.warnings).toBe(0);
  },
);

it("keeps plain text notices after the result summary and out of finding counts", () => {
  const report = Object.assign(createReport(), {
    hookUpdate: HOOK_UPDATE_NOTICE,
  });
  const output = renderText(report, { width: 120, color: false });
  expect(output).toContain(
    "HOOK UPDATE NEEDED\nSwarm’s hooks need updating.\nRun zedbee init to refresh them.",
  );
  expect(output.indexOf("HOOK UPDATE NEEDED")).toBeGreaterThan(
    output.indexOf("1 check run"),
  );
  expect(output).toContain("All checks passed. Commit allowed.");
});

it("serializes fixed setup metadata without altering JSON or SARIF outcomes", () => {
  const report = Object.assign(createReport(), {
    hookUpdate: HOOK_UPDATE_NOTICE,
  });
  const json = JSON.parse(renderJson(report));
  expect(json.hookUpdate).toEqual(HOOK_UPDATE_NOTICE);
  expect(json.exitCode).toBe(0);
  expect(json.summary.warnings).toBe(0);
  const sarif = JSON.parse(renderSarif(report));
  expect(sarif.runs[0].invocations[0].properties.hookUpdate).toEqual(
    HOOK_UPDATE_NOTICE,
  );
  expect(sarif.runs[0].results).toEqual([]);
});

it("does not echo untrusted notice text or add setup fields to current-hook output", () => {
  const report = Object.assign(createReport(), {
    hookUpdate: { ...HOOK_UPDATE_NOTICE, message: "private hook contents" },
  });
  expect(renderJson(report)).not.toContain("private hook contents");
  expect(JSON.parse(renderJson(createReport()))).not.toHaveProperty(
    "hookUpdate",
  );
  expect(
    renderText(createReport(), { width: 120, color: false }),
  ).not.toContain("HOOK UPDATE NEEDED");
});

it.each([0, 1, 2] as const)(
  "attaches the real hook inspection to scan output without changing exit %s",
  async (exitCode) => {
    const repo = await createGitRepository();
    await repo.write("package.json", '{"devDependencies":{"zedbee":"*"}}');
    await repo.write(
      "node_modules/zedbee/package.json",
      '{"name":"zedbee","bin":"dist/cli.js"}',
    );
    await repo.write(
      "node_modules/zedbee/dist/cli.js",
      "throw Error('not executed');",
    );
    await repo.write(
      ".git/hooks/pre-commit",
      "#!/bin/sh\nnpx --no-install zedbee scan --hook-invocation\n",
    );
    const stdout: string[] = [];
    const stderr: string[] = [];
    const result = await executeScanCommand(
      { cwd: repo.root, format: "json", color: false, animations: false },
      {
        stdinIsTTY: false,
        stdoutIsTTY: false,
        width: 120,
        env: {},
        writeStdout: (s) => stdout.push(s),
        writeStderr: (s) => stderr.push(s),
      },
      {
        resolveRepositoryRoot: async () => repo.root,
        scan: async () =>
          createReport({
            repositoryRoot: repo.root,
            exitCode,
            outcome:
              exitCode === 0
                ? "pass"
                : exitCode === 1
                  ? "blocked"
                  : "incomplete",
          }),
        openInk: async () => {
          throw Error("JSON must not render Ink");
        },
        preparePresentation: async () => ({
          ...presentation,
          automatic: false,
          reportStatus: "not-requested",
        }),
      },
    );
    expect(result).toBe(exitCode);
    expect(JSON.parse(stdout.join("")).hookUpdate).toEqual(HOOK_UPDATE_NOTICE);
    expect(stderr).toEqual([]);
  },
);

it("reports the same shared Husky update from scan and doctor in a linked worktree", async () => {
  const repo = await createGitRepository();
  await repo.write(".gitignore", "node_modules/\n.husky/_/\n");
  await repo.write("web/package.json", '{"devDependencies":{"zedbee":"*"}}');
  await repo.write(
    "web/node_modules/zedbee/package.json",
    '{"name":"zedbee","bin":"dist/cli.js"}',
  );
  await repo.write(
    "web/node_modules/zedbee/dist/cli.js",
    "throw Error('not executed');",
  );
  await repo.write(
    ".husky/_/pre-commit",
    '#!/usr/bin/env sh\n. "$(dirname "$0")/h"\n',
  );
  await repo.write(
    ".husky/_/h",
    await readFile(
      join(dirname(fileURLToPath(import.meta.resolve("husky"))), "husky"),
      "utf8",
    ),
  );
  await chmod(join(repo.root, ".husky/_/pre-commit"), 0o755);
  const command = await resolveHookCommand(repo.root);
  await repo.write(".husky/pre-commit", command + "\n");
  await repo.commitAll("consumer with a current tracked hook");

  const linked = join(await realpath(repo.root), "linked");
  expect(
    (await repo.git(["worktree", "add", "-b", "shared-hooks", linked]))
      .exitCode,
  ).toBe(0);
  await mkdir(join(linked, "web/node_modules"), { recursive: true });
  await symlink(
    await realpath(join(repo.root, "web/node_modules/zedbee")),
    join(linked, "web/node_modules/zedbee"),
    "junction",
  );
  await repo.write(
    ".husky/pre-commit",
    "npx --no-install zedbee scan --hook-invocation\n",
  );
  expect(
    (
      await repo.git([
        "config",
        "core.hooksPath",
        join(await realpath(repo.root), ".husky/_"),
      ])
    ).exitCode,
  ).toBe(0);

  const context = { cwd: join(linked, "web"), environment: {} };
  async function inspectBoth() {
    const stdout: string[] = [];
    const exitCode = await executeScanCommand(
      { cwd: context.cwd, format: "json", color: false, animations: false },
      {
        stdinIsTTY: false,
        stdoutIsTTY: false,
        width: 120,
        env: {},
        writeStdout: (value) => stdout.push(value),
        writeStderr: () => {},
      },
      {
        resolveRepositoryRoot: async (cwd) =>
          (await new GitClient(cwd).run(["rev-parse", "--show-toplevel"]))
            .stdout,
        scan: async () => createReport({ repositoryRoot: linked }),
        openInk: async () => {
          throw Error("JSON must not render Ink");
        },
        preparePresentation: async () => ({
          ...presentation,
          automatic: false,
          reportStatus: "not-requested",
        }),
      },
    );
    expect(exitCode).toBe(0);
    return {
      scan: JSON.parse(stdout.join("")).hookUpdate,
      doctor: await defaultDiagnosticProbe("hook-state", context),
    };
  }

  const stale = await inspectBoth();
  expect(stale.scan).toMatchObject({
    code: "HOOK_UPDATE_NEEDED",
    remediation: expect.stringContaining("main checkout"),
  });
  expect(stale.doctor).toMatchObject({
    status: "warning",
    message: stale.scan.message,
    remediation: stale.scan.remediation,
  });
  await repo.write(".husky/pre-commit", command + "\n");
  await repo.write(
    "linked/.husky/pre-commit",
    "npx --no-install zedbee scan --hook-invocation\n",
  );
  const current = await inspectBoth();
  expect(current.scan).toBeUndefined();
  expect(current.doctor).toMatchObject({
    status: "pass",
    message: expect.stringContaining("shared Husky"),
  });
  await repo.write(".husky/pre-commit", "npm test\n");
  const inactive = await inspectBoth();
  expect(inactive.scan).toBeUndefined();
  expect(inactive.doctor).toMatchObject({
    status: "warning",
    message: "The shared Husky pre-commit hook does not invoke Zedbee.",
  });
});
