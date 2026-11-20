import { expect, it } from "vitest";
import { CHECK_IDS } from "../../src/config/schema.js";
import { runScan } from "../../src/scan/run-scan.js";
import { createGitRepository } from "../helpers/git-repository.js";
import { createInspectionFixture } from "../inspection/fixture.js";
import { inspectRepository } from "../../src/inspection/inspect-repository.js";
import { assertRequiredInstallation } from "../../src/checks/comparison-context.js";
import { CapturedDependencies } from "../../src/cache/captured-dependencies.js";

it.each(["contextual", "source-free"] as const)(
  "keeps progress source-free while presenting reviewed %s installation details",
  async (diagnosticMessages) => {
    const repo = await createGitRepository();
    const manifest = {
      name: "fixture",
      version: "1.0.0",
      devDependencies: { "@types/node": "*" },
    };
    await repo.write("package.json", JSON.stringify(manifest));
    await repo.write(
      "tsconfig.json",
      JSON.stringify({
        compilerOptions: { strict: true },
        include: ["src"],
      }),
    );
    await repo.write(
      "src/value.ts",
      "export const value = process.version;\n",
    );
    await repo.write(
      ".zedbeerc.jsonc",
      JSON.stringify({
        schemaVersion: 1,
        checks: Object.fromEntries(
          CHECK_IDS.map((id) => [id, id === "types" ? "error" : "off"]),
        ),
      }),
    );
    await repo.commitAll("baseline");
    await repo.write(
      "package.json",
      JSON.stringify({ ...manifest, version: "1.0.1" }),
    );
    await repo.git(["add", "package.json"]);
    const events: unknown[] = [];
    const report = await runScan({
      repositoryRoot: repo.root,
      cache: false,
      diagnosticMessages,
      onEvent: (event) => events.push(event),
    });
    expect(report.outcome).toBe("incomplete");
    expect(JSON.stringify(events)).not.toContain("@types/node");
    const message = report.checks.find(
      (c) => c.error?.code === "COMPARISON_INSTALLATION_UNAVAILABLE",
    )!.error!.message;
    if (diagnosticMessages === "contextual")
      expect(message).toContain("@types/node");
    else expect(message).not.toContain("@types/node");
  },
);

it.each(["token", "context"])(
  "withholds sensitive dependency identifiers before result serialization (%s)",
  async (kind) => {
    const fixture = await createInspectionFixture();
    const name =
      kind === "token"
        ? "ghp_abcdefghijklmnopqrstuvwxyz0123456789"
        : "credential-fixture-package";
    await fixture.writeJson("package.json", {
      name: "fixture",
      dependencies: { [name]: "*" },
      ...(kind === "context" ? { password: name } : {}),
    });
    const inspection = await inspectRepository(fixture.root);
    const program = {
      getOptionsDiagnostics: () => [
        {
          code: 2307,
          messageText: `Cannot find module '${name}' or its corresponding type declarations.`,
        },
      ],
      getSourceFiles: () => [],
      getCompilerOptions: () => ({}),
    } as unknown as import("typescript").Program;
    let failure: unknown;
    try {
      await assertRequiredInstallation({
        programs: [program],
        repositoryRoot: fixture.root,
        inspection,
        workspace: inspection.workspaces[0]!,
        dependencies: new CapturedDependencies({
          repositoryRoot: fixture.root,
        }),
        side: "baseline",
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      code: "COMPARISON_INSTALLATION_UNAVAILABLE",
    });
    expect(
      `${(failure as Error).message} ${(failure as { remediation: string }).remediation}`,
    ).not.toContain(name);
  },
);
