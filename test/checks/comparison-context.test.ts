import { expect, it } from "vitest";
import { createInspectionFixture } from "../inspection/fixture.js";
import { CapturedDependencies } from "../../src/cache/captured-dependencies.js";
import {
  assertRequiredInstallation,
  comparisonContext,
  sanitizeComparisonContext,
  verifyComparisonInputs,
} from "../../src/checks/comparison-context.js";

it.each(["contextual", "source-free"] as const)(
  "identifies a missing declared package according to the %s message policy",
  async (diagnosticMessages) => {
    const fixture = await createInspectionFixture();
    await fixture.writeJson("package.json", {
      name: "fixture",
      devDependencies: { "@types/node": "26.0.0" },
    });
    await fixture.write(
      "node_modules/.installation-present",
      "directory exists\n",
    );
    const { inspectRepository } =
      await import("../../src/inspection/inspect-repository.js");
    const inspection = await inspectRepository(fixture.root);
    const program = {
      getOptionsDiagnostics: () => [
        { code: 2591, messageText: "Cannot find name 'process'." },
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
        diagnosticMessages,
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      code: "COMPARISON_INSTALLATION_UNAVAILABLE",
      path: "package.json",
      snapshot: "last-commit",
    });
    const text = `${(failure as Error).message} ${(failure as { remediation: string }).remediation}`;
    if (diagnosticMessages === "contextual")
      expect(text).toContain("@types/node");
    else expect(text).not.toContain("@types/node");
  },
);
it("refuses attribution evidence after dependency bytes change", async () => {
  const f = await createInspectionFixture();
  await f.write(
    "node_modules/example/index.d.ts",
    "export const value: number;\n",
  );
  const capture = new CapturedDependencies({ repositoryRoot: f.root });
  expect(
    capture.readFile(f.root + "/node_modules/example/index.d.ts"),
  ).toBeDefined();
  expect(verifyComparisonInputs(capture).status).toBe("comparable");
  await f.write(
    "node_modules/example/index.d.ts",
    "export const value: string;\n",
  );
  expect(() => verifyComparisonInputs(capture)).toThrow(
    expect.objectContaining({ code: "COMPARISON_INPUTS_CHANGED" }),
  );
});
it("validates the exact public comparison metadata boundary", () => {
  const context = comparisonContext();
  expect(sanitizeComparisonContext(context)).toEqual(context);
  for (const value of [
    { ...context, raw: "secret" },
    { ...context, status: "unverified" },
    {
      ...context,
      status: "environment-incomplete",
      reason: "inputs-changed",
    },
    { ...context, analyzerVersion: "/private/path" },
  ])
    expect(() => sanitizeComparisonContext(value)).toThrow();
});

it.each([
  "fs",
  "node:fs",
  "path",
  "node:path",
  "fs/promises",
  "node:fs/promises",
  "node:test",
])(
  "maps legacy unresolved builtin %s to declared Node types",
  async (specifier) => {
    const f = await createInspectionFixture();
    await f.writeJson("package.json", {
      name: "fixture",
      devDependencies: { "@types/node": "25.0.0" },
    });
    const { inspectRepository } =
      await import("../../src/inspection/inspect-repository.js");
    const { assertRequiredInstallation } =
      await import("../../src/checks/comparison-context.js");
    const inspection = await inspectRepository(f.root);
    const program = {
      getOptionsDiagnostics: () => [
        {
          code: 2307,
          messageText: `Cannot find module '${specifier}' or its corresponding type declarations.`,
        },
      ],
      getSourceFiles: () => [],
      getCompilerOptions: () => ({}),
    } as unknown as import("typescript").Program;
    await expect(
      assertRequiredInstallation({
        programs: [program],
        repositoryRoot: f.root,
        inspection,
        workspace: inspection.workspaces[0]!,
        dependencies: new CapturedDependencies({ repositoryRoot: f.root }),
        side: "target",
      }),
    ).rejects.toThrow(
      expect.objectContaining({
        code: "COMPARISON_INSTALLATION_UNAVAILABLE",
      }),
    );
  },
);
