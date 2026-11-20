import { expect, it, vi } from "vitest";
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

it.each([false, true])(
  "keeps semantic diagnostics lazy when complete installation readiness is proved (%s)",
  async (installed) => {
    const f = await createInspectionFixture();
    await f.writeJson("package.json", {
      name: "ready",
      ...(installed ? { dependencies: { example: "1.0.0" } } : {}),
    });
    if (installed)
      await f.writeJson("node_modules/example/package.json", {
        name: "example",
        version: "1.0.0",
      });
    const { inspectRepository } =
      await import("../../src/inspection/inspect-repository.js");
    const inspection = await inspectRepository(f.root);
    const diagnostics = vi.fn(() => {
      throw Error("Eager semantic work");
    });
    const program = {
      getOptionsDiagnostics: () => [],
      getSourceFiles: () => [{ fileName: f.root + "/src/value.ts" }],
      isSourceFileFromExternalLibrary: () => false,
      isSourceFileDefaultLibrary: () => false,
      getSemanticDiagnostics: diagnostics,
    } as unknown as import("typescript").Program;
    const dependencies = new CapturedDependencies({ repositoryRoot: f.root });
    if (installed)
      expect(
        dependencies.fileExists(f.root + "/node_modules/example/package.json"),
      ).toBe(true);
    await assertRequiredInstallation({
      programs: [program],
      repositoryRoot: f.root,
      inspection,
      workspace: inspection.workspaces[0]!,
      dependencies,
      side: "target",
    });
    expect(diagnostics).not.toHaveBeenCalled();
    expect(verifyComparisonInputs(dependencies).status).toBe("comparable");
    if (installed) {
      await f.writeJson("node_modules/example/package.json", {
        name: "example",
        version: "2.0.0",
      });
      expect(() => verifyComparisonInputs(dependencies)).toThrow(
        expect.objectContaining({ code: "COMPARISON_INPUTS_CHANGED" }),
      );
    }
  },
);
it("does not pollute the canonical capture when an unused declaration has an unsupported installation", async () => {
  const f = await createInspectionFixture(),
    outside = await createInspectionFixture();
  await f.writeJson("package.json", {
    name: "fallback",
    dependencies: { example: "1.0.0" },
  });
  await outside.writeJson("package.json", {
    name: "example",
    version: "1.0.0",
  });
  await f.symlink(outside.root, "node_modules/example");
  const { inspectRepository } =
    await import("../../src/inspection/inspect-repository.js");
  const inspection = await inspectRepository(f.root);
  const diagnostics = vi.fn(() => []);
  const program = {
    getOptionsDiagnostics: () => [],
    getSourceFiles: () => [{ fileName: f.root + "/src/value.ts" }],
    isSourceFileFromExternalLibrary: () => false,
    isSourceFileDefaultLibrary: () => false,
    getSemanticDiagnostics: diagnostics,
  } as unknown as import("typescript").Program;
  const dependencies = new CapturedDependencies({ repositoryRoot: f.root });
  await assertRequiredInstallation({
    programs: [program],
    repositoryRoot: f.root,
    inspection,
    workspace: inspection.workspaces[0]!,
    dependencies,
    side: "target",
  });
  expect(diagnostics).toHaveBeenCalledOnce();
  expect(verifyComparisonInputs(dependencies).status).toBe("comparable");
});
it("does not spend mandatory capture capacity on an optional unused-declaration shortcut", async () => {
  const f = await createInspectionFixture();
  await f.writeJson("package.json", {
    name: "unused",
    dependencies: { example: "1.0.0" },
  });
  await f.writeJson("node_modules/example/package.json", {
    name: "example",
    version: "1.0.0",
  });
  const { inspectRepository } =
    await import("../../src/inspection/inspect-repository.js");
  const inspection = await inspectRepository(f.root);
  const semantic = vi.fn(() => []);
  const program = {
    getOptionsDiagnostics: () => [],
    getSourceFiles: () => [{ fileName: f.root + "/src/value.ts" }],
    isSourceFileFromExternalLibrary: () => false,
    isSourceFileDefaultLibrary: () => false,
    getSemanticDiagnostics: semantic,
  } as unknown as import("typescript").Program;
  const dependencies = new CapturedDependencies({ repositoryRoot: f.root });
  await assertRequiredInstallation({
    programs: [program],
    repositoryRoot: f.root,
    inspection,
    workspace: inspection.workspaces[0]!,
    dependencies,
    side: "target",
  });
  expect(semantic).toHaveBeenCalledOnce();
  expect(dependencies.manifest()!.probes).toHaveLength(0);
});

it.each(["contextual", "source-free"] as const)(
  "describes invalid dependency lookup metadata under %s reporting",
  async (policy) => {
    const fixture = await createInspectionFixture();
    const snapshots = {
      baselineDir: fixture.root + "/baseline",
      targetDir: fixture.root + "/target",
    };
    await fixture.write("baseline/e2e/package.json", "{}");
    await fixture.write("target/e2e/package.json", "{}");
    const capture = new CapturedDependencies({
      repositoryRoot: fixture.root,
      snapshots,
    });
    capture.fileExists(snapshots.baselineDir + "/e2e/fixture:input.ts");
    expect(() => verifyComparisonInputs(capture, policy)).toThrow(
      expect.objectContaining({
        code: "COMPARISON_INPUTS_UNVERIFIED",
        snapshot: "last-commit",
        message:
          policy === "contextual"
            ? expect.stringContaining("e2e/fixture:input.ts")
            : "Dependency tracking could not validate a file lookup record.",
      }),
    );
  },
);
