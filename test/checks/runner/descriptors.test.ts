import { describe, expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { CHECK_METADATA } from "../../../src/checks/metadata.js";
import { createManagedAdapters } from "../../../src/checks/descriptors.js";
import { resolveConfig } from "../../../src/config/profiles.js";
import { createFilePolicyResolver } from "../../../src/config/file-policy.js";
import {
  serializeCheckContext,
  restoreCheckContext,
} from "../../../src/checks/runner/context.js";
import type { CheckRunContext } from "../../../src/checks/adapter.js";
import { runAnalyzerJob } from "../../../src/checks/runner/run-job.js";
import { loadAnalyzerAdapter } from "../../../src/checks/runner/registry.js";
import type { CheckId } from "../../../src/config/schema.js";
import type { ChangedFile } from "../../../src/git/change-set.js";
import type { WorkspaceInspection } from "../../../src/inspection/types.js";

function context(): CheckRunContext {
  const config = resolveConfig({
    schemaVersion: 1,
    profile: "fast",
    overrides: [
      {
        files: ["src/*.js"],
        checks: { formatting: { settings: { semi: false } } },
      },
    ],
  });
  const changeSet = {
    files: new Map([
      [
        "src/a.js",
        {
          path: "src/a.js",
          previousPath: "old.js",
          status: "renamed" as const,
          addedRanges: [{ start: 2, end: 3 }],
        },
      ],
    ]),
    isEmpty: false,
    containsAddedLine: () => false,
  };
  const inspection = {
    snapshotRoot: "/snapshot",
    packageManager: "unknown" as const,
    lockfiles: [],
    workspaces: [],
  };
  return {
    repositoryRoot: "/repo",
    config,
    changeSet,
    policyForFile: createFilePolicyResolver(config, changeSet),
    signal: new AbortController().signal,
    target: { id: ".", kind: "repository", relativeRoot: "." },
    policy: config.checks.formatting,
    snapshots: {
      baselineDir: "/before",
      targetDir: "/after",
      baselineRef: "HEAD",
      targetRef: "index",
      unsupportedEntries: [],
    },
    baselineInspection: inspection,
    targetInspection: inspection,
  };
}

describe("default managed execution descriptors", () => {
  it("selects the renamed target workspace and skips deleted files for source-only checks", async () => {
    const original = context();
    const workspace = (root: string): WorkspaceInspection => ({
      relativeRoot: root,
      manifestPath: `${root}/package.json`,
      sourceFiles: [`${root}/value.tsx`],
      tsconfigPaths: [],
      environments: [],
      dependencyDeclarations: [],
    });
    const files: ChangedFile[] = [
      {
        path: "packages/new/value.tsx",
        previousPath: "packages/old/value.tsx",
        status: "renamed",
        addedRanges: [],
      },
      {
        path: "packages/deleted/value.tsx",
        status: "deleted",
        addedRanges: [],
      },
    ];
    const input = {
      ...original,
      changeSet: {
        ...original.changeSet,
        files: new Map(files.map((file) => [file.path, file])),
      },
      baselineInspection: {
        ...original.baselineInspection,
        workspaces: [workspace("packages/old"), workspace("packages/deleted")],
      },
      targetInspection: {
        ...original.targetInspection,
        workspaces: [workspace("packages/new"), workspace("packages/deleted")],
      },
    };
    for (const id of [
      "lint",
      "types",
      "cyclomaticComplexity",
      "readabilityComplexity",
      "structuralSecurity",
      "duplication",
    ]) {
      const adapter = createManagedAdapters().find(
        (adapter) => adapter.id === id,
      )!;
      expect(await adapter.inspect(input)).toMatchObject({
        applies: true,
        requiresBaseline: true,
        targets: [
          {
            id: "packages/new",
            kind: "workspace",
            relativeRoot: "packages/new",
          },
        ],
      });
    }
    const deletedOnly = {
      ...input,
      changeSet: {
        ...input.changeSet,
        files: new Map([[files[1]!.path, files[1]!]]),
      },
    };
    for (const id of ["formatting", "lint", "types", "secrets"]) {
      expect(
        await createManagedAdapters()
          .find((adapter) => adapter.id === id)!
          .inspect(deletedOnly),
      ).toMatchObject({ applies: false });
    }
    for (const id of ["dependencyArchitecture", "deadCode"]) {
      expect(
        await createManagedAdapters()
          .find((adapter) => adapter.id === id)!
          .inspect(deletedOnly),
      ).toMatchObject({
        applies: true,
        targets: [
          {
            id: "packages/deleted",
            kind: "workspace",
            relativeRoot: "packages/deleted",
          },
        ],
      });
    }
  });

  it("runs vulnerability analysis for a deleted baseline lockfile but not a manifest-only change", async () => {
    const original = context();
    const adapter = createManagedAdapters().find(
      (adapter) => adapter.id === "vulnerabilities",
    )!;
    for (const [path, applies] of [
      ["package-lock.json", true],
      ["package.json", false],
    ] as const) {
      const input = {
        ...original,
        config: {
          ...original.config,
          checks: {
            ...original.config.checks,
            vulnerabilities: {
              ...original.config.checks.vulnerabilities,
              when: "relevant" as const,
            },
          },
        },
        baselineInspection: {
          ...original.baselineInspection,
          lockfiles: ["package-lock.json"],
        },
        changeSet: {
          ...original.changeSet,
          files: new Map([
            [path, { path, status: "deleted" as const, addedRanges: [] }],
          ]),
        },
      };
      expect(await adapter.inspect(input)).toMatchObject({ applies });
    }
  });

  it("includes Ink for React correctness and only browser renderers for accessibility", async () => {
    const original = context();
    const workspaces: WorkspaceInspection[] = ["ink", "react-dom", "node"].map(
      (environment) => ({
        relativeRoot: environment,
        manifestPath: `${environment}/package.json`,
        sourceFiles: [`${environment}/view.tsx`],
        tsconfigPaths: [],
        environments:
          environment === "node" ? [] : [environment as "ink" | "react-dom"],
        dependencyDeclarations: [],
      }),
    );
    const input = {
      ...original,
      targetInspection: { ...original.targetInspection, workspaces },
      changeSet: {
        ...original.changeSet,
        files: new Map(
          workspaces.map((workspace) => {
            const path = workspace.sourceFiles[0]!;
            return [
              path,
              { path, status: "modified" as const, addedRanges: [] },
            ];
          }),
        ),
      },
    };
    for (const [id, targets] of [
      ["reactCorrectness", ["ink", "react-dom"]],
      ["reactAccessibility", ["react-dom"]],
    ] as const) {
      expect(
        await createManagedAdapters()
          .find((adapter) => adapter.id === id)!
          .inspect(input),
      ).toMatchObject({
        applies: true,
        targets: targets.map((root) => ({
          id: root,
          kind: "workspace",
          relativeRoot: root,
        })),
      });
    }
  });

  it.each(Object.keys(CHECK_METADATA))(
    "routes %s execution through the shared runner",
    async (id) => {
      const run = vi.fn().mockResolvedValue(
        id === "formatting"
          ? { checkId: id, status: "completed", durationMs: 0, findings: [] }
          : {
              checkId: id,
              target: context().target,
              baselineObservations: [],
              targetObservations: [],
            },
      );
      const adapter = createManagedAdapters(run as never).find(
        (adapter) => adapter.id === id,
      )!;
      const input = context();
      if (adapter.output === "observations") await adapter.collect(input);
      else await adapter.runLegacy(input);
      expect(run).toHaveBeenCalledWith(
        expect.objectContaining({
          version: 1,
          checkId: id,
          operation: id === "formatting" ? "runLegacy" : "collect",
        }),
        { signal: input.signal },
      );
      if (adapter.planFixes) {
        await adapter.planFixes(input, []);
        expect(run).toHaveBeenLastCalledWith(
          expect.objectContaining({
            checkId: id,
            operation: "planFixes",
            findings: [],
          }),
          { signal: input.signal },
        );
      }
    },
  );
  it("round-trips change lookup and authoritative rename-aware file policy as data", () => {
    const original = context();
    const serialized = serializeCheckContext(original);
    const copied = JSON.parse(JSON.stringify(serialized));
    const restored = restoreCheckContext(copied, original.signal);
    expect(restored.changeSet.containsAddedLine("src/a.js", 2)).toBe(true);
    expect(restored.changeSet.containsAddedLine("src/a.js", 4)).toBe(false);
    expect(
      restored.policyForFile("formatting", "old.js", "baseline").settings.semi,
    ).toBe(false);
  });
  it.each(Object.keys(CHECK_METADATA))(
    "runs %s behind a real child boundary",
    async (id) => {
      const workerEntry = fileURLToPath(
        new URL("./fixtures/worker.mjs", import.meta.url),
      );
      const adapters = createManagedAdapters((request, options) =>
        runAnalyzerJob(request, { ...options, workerEntry }),
      );
      const adapter = adapters.find((adapter) => adapter.id === id)!;
      const input = context();
      const workerPid =
        adapter.output === "observations"
          ? Number(
              (await adapter.collect(input)).targetObservations[0]!.identity,
            )
          : Number((await adapter.runLegacy(input)).findings[0]!.id);
      expect(workerPid).toBeGreaterThan(0);
      expect(workerPid).not.toBe(process.pid);
      if (adapter.planFixes)
        expect(await adapter.planFixes(input, [])).toEqual([]);
    },
  );
  it.each(Object.keys(CHECK_METADATA))(
    "preserves %s applicability across source and dependency changes",
    async (id) => {
      const direct = await loadAnalyzerAdapter(id as CheckId);
      const proxy = createManagedAdapters().find(
        (adapter) => adapter.id === id,
      )!;
      for (const when of ["always", "relevant"] as const) {
        for (const path of [
          "src/a.tsx",
          "package.json",
          "tsconfig.json",
          "package-lock.json",
          "unrelated.txt",
        ]) {
          const original = context();
          const workspace = {
            relativeRoot: ".",
            manifestPath: "package.json",
            sourceFiles: ["src/a.tsx"],
            tsconfigPaths: ["tsconfig.json"],
            environments: ["react-dom" as const, "typescript" as const],
            dependencyDeclarations: [],
          };
          const inspection = {
            ...original.targetInspection,
            workspaces: [workspace],
            lockfiles: ["package-lock.json"],
          };
          const input = {
            ...original,
            config: {
              ...original.config,
              checks: {
                ...original.config.checks,
                [id]: { ...original.config.checks[id as CheckId], when },
              },
            },
            changeSet: {
              ...original.changeSet,
              files: new Map([
                [path, { path, status: "modified" as const, addedRanges: [] }],
              ]),
            },
            baselineInspection: inspection,
            targetInspection: inspection,
          };
          expect(await proxy.inspect(input)).toEqual(
            await direct.inspect(input),
          );
        }
      }
    },
  );
});
