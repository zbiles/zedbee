import { describe, expect, it } from "vitest";
import { execa } from "execa";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { managedAutomaticFixFor } from "../../src/attribution/fingerprint.js";
import { sanitizeCheckResult } from "../../src/checks/sanitize-result.js";
import { renderJson } from "../../src/renderers/json.js";
import { renderSarif } from "../../src/renderers/sarif.js";
import { renderText } from "../../src/renderers/text.js";
import { createFinding, createReport } from "../helpers/scan-report.js";
import { createGitRepository } from "../helpers/git-repository.js";
import {
  resolveHookCommand,
  resolveInstalledCliCommand,
} from "../../src/hooks/command.js";
import { fixCommandText } from "../../src/reporting/fix-command.js";
import { executeScanCommand } from "../../src/commands/scan.js";
import { createElement } from "react";
import { render } from "ink-testing-library";
import { ScanApp } from "../../src/ui/scan-app.js";

function reportFor(prefix?: readonly string[]) {
  const finding = createFinding({
    check: "formatting",
    automaticFix: managedAutomaticFixFor("formatting")!,
  });
  return Object.assign(
    createReport({
      checks: [
        {
          checkId: "formatting",
          status: "completed",
          durationMs: 0,
          findings: [finding],
        },
      ],
      summary: {
        passed: 0,
        warnings: 0,
        failed: 1,
        incomplete: 0,
        findings: [finding],
      },
    }),
    prefix === undefined ? {} : { installedCliCommand: prefix },
  );
}

describe("installed CLI fix guidance", () => {
  it.each(["web", "web app's"])(
    "uses the installed %s CLI in public outputs without changing canonical findings",
    (project) => {
      const path = `./${project}/node_modules/zedbee/dist/cli.js`;
      const report = reportFor(["node", path]);
      const quoted = `'${path.replaceAll("'", "'\\''")}'`;
      const text = renderText(report, { width: 240, color: false });
      expect(text).toContain(`node ${quoted} fix formatting`);
      expect(text).not.toContain("npx --no-install zedbee fix formatting");
      const json = JSON.parse(renderJson(report));
      expect(json.checks[0].findings[0].automaticFix.command).toEqual([
        "node",
        path,
        "fix",
        "formatting",
      ]);
      const sarif = JSON.parse(renderSarif(report));
      expect(
        sarif.runs[0].results[0].properties["zedbee/automaticFixCommand"],
      ).toEqual(["node", path, "fix", "formatting"]);
      expect(
        sanitizeCheckResult(report.checks[0]!).findings[0]!.automaticFix,
      ).toEqual(managedAutomaticFixFor("formatting"));
    },
  );

  it("retains the canonical fallback when no local installation is available", () => {
    expect(renderText(reportFor(), { width: 240, color: false })).toContain(
      "npx --no-install zedbee fix formatting",
    );
  });

  it.each([false, true])(
    "uses the installed CLI in text and Ink with abbreviated=%s",
    (abbreviated) => {
      const report = reportFor([
        "node",
        "./web app's/node_modules/zedbee/dist/cli.js",
      ]);
      const presentation = {
        automatic: abbreviated,
        reportStatus: "available" as const,
        findings: report.summary.findings,
        totalFindingCount: 1,
        abbreviated,
        reportPath: "/private/tmp/zedbee-reports/hash/complete.json",
        maximumAge: "24h",
        warnings: [],
      };
      const expected =
        "node './web app'\\''s/node_modules/zedbee/dist/cli.js' fix formatting";
      expect(
        renderText(report, { width: 400, color: false, presentation }),
      ).toContain(expected);
      const app = render(
        createElement(ScanApp, {
          events: [],
          elapsedMs: 0,
          width: 400,
          color: false,
          animations: false,
          report,
          presentation,
        }),
      );
      expect(app.lastFrame()).toContain(expected);
      app.unmount();
    },
  );

  it.each([
    ["sh", "./web/node_modules/zedbee/dist/cli.js"],
    ["node", "./../cli.js"],
    ["node", "./web/\ncli.js"],
  ])("rejects unsafe output command prefixes %j", (...prefix) => {
    expect(
      renderText(reportFor(prefix), { width: 240, color: false }),
    ).toContain("npx --no-install zedbee fix formatting");
    expect(
      JSON.parse(renderJson(reportFor(prefix))).checks[0].findings[0]
        .automaticFix.command,
    ).toEqual(managedAutomaticFixFor("formatting")!.command);
  });

  it.each(["web", "web app's"])(
    "executes the same %s installation as the hook from a nested cwd",
    async (project) => {
      const repository = await createGitRepository();
      await repository.write(".gitignore", "node_modules/\n");
      await repository.write(
        `${project}/package.json`,
        JSON.stringify({ devDependencies: { zedbee: "*" } }),
      );
      await repository.write(
        `${project}/node_modules/zedbee/package.json`,
        JSON.stringify({ name: "zedbee", bin: { zedbee: "dist/cli.cjs" } }),
      );
      await repository.write(
        `${project}/node_modules/zedbee/dist/cli.cjs`,
        "require('node:fs').writeFileSync('invocation.json', JSON.stringify({cwd: process.cwd(), args: process.argv.slice(2)}));",
      );
      const prefix = await resolveInstalledCliCommand(repository.root);
      expect(prefix).toEqual([
        "node",
        `./${project}/node_modules/zedbee/dist/cli.cjs`,
      ]);
      const hook = await resolveHookCommand(repository.root);
      const fix = fixCommandText(managedAutomaticFixFor("formatting")!, prefix);
      const options = { cwd: join(repository.root, project), reject: false };
      expect((await execa("sh", ["-c", hook], options)).exitCode).toBe(0);
      const hooked = JSON.parse(await repository.read("invocation.json"));
      expect((await execa("sh", ["-c", fix], options)).exitCode).toBe(0);
      expect(JSON.parse(await repository.read("invocation.json"))).toEqual({
        cwd: hooked.cwd,
        args: ["fix", "formatting"],
      });
      expect(hooked.cwd).toBe(await realpath(repository.root));
    },
  );

  it("binds commands before rendering and preparing the complete report", async () => {
    const repository = await createGitRepository();
    await repository.write(".gitignore", "node_modules/\n");
    await repository.write(
      "web/package.json",
      '{"devDependencies":{"zedbee":"*"}}',
    );
    await repository.write(
      "web/node_modules/zedbee/package.json",
      '{"name":"zedbee","bin":"dist/cli.js"}',
    );
    await repository.write("web/node_modules/zedbee/dist/cli.js", "");
    const report = { ...reportFor(), repositoryRoot: repository.root };
    const output: string[] = [];
    let completeReportCommand: unknown;
    expect(
      await executeScanCommand(
        {
          cwd: repository.root,
          format: "json",
          color: false,
          animations: false,
        },
        {
          stdinIsTTY: false,
          stdoutIsTTY: false,
          width: 80,
          env: {},
          writeStdout: (value) => output.push(value),
          writeStderr() {},
        },
        {
          async resolveRepositoryRoot() {
            return repository.root;
          },
          async scan() {
            return report;
          },
          async openInk() {
            throw new Error("unused");
          },
          async preparePresentation(prepared) {
            completeReportCommand = JSON.parse(renderJson(prepared)).checks[0]
              .findings[0].automaticFix.command;
            return {
              automatic: false,
              reportStatus: "not-requested",
              findings: prepared.summary.findings,
              totalFindingCount: 1,
              abbreviated: false,
              warnings: [],
            };
          },
        },
      ),
    ).toBe(0);
    const expected = [
      "node",
      "./web/node_modules/zedbee/dist/cli.js",
      "fix",
      "formatting",
    ];
    expect(completeReportCommand).toEqual(expected);
    expect(
      JSON.parse(output.join("")).checks[0].findings[0].automaticFix.command,
    ).toEqual(expected);
    expect(report.checks[0]!.findings[0]!.automaticFix!.command[0]).toBe("npx");
  });
});
