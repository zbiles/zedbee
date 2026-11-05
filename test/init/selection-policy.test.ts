import { describe, expect, it } from "vitest";
import type { RepositoryInspection } from "../../src/inspection/types.js";
import { createInitProposal } from "../../src/init/recommend.js";
import {
  buildInitSelectionOptions,
  type InitSelectionContext,
} from "../../src/init/selection-policy.js";
import type { EvaluatedExecutableImports } from "../../src/init/types.js";

const inspection: RepositoryInspection = {
  snapshotRoot: "/repo",
  packageManager: "npm",
  lockfiles: [],
  workspaces: [],
};
const evaluated: EvaluatedExecutableImports = {
  imported: { settings: { singleQuote: true }, overrides: [], limitations: [] },
  evaluatedConfigs: [
    { path: "web/prettier.config.js", sha256: "evaluated-bytes" },
  ],
};
function context(): InitSelectionContext {
  return {
    base: { repositoryRoot: "/repo", configBefore: null },
    defaults: { profile: "recommended", hook: "none", scope: "projects" },
    integrations: new Map([
      [
        "none",
        {
          hook: "none",
          activation: {
            status: "not-requested",
            message: "No hooks requested.",
          },
        },
      ],
    ]),
    formatting: {
      imported: {
        settings: { semi: false },
        overrides: [],
        limitations: ["Executable config not evaluated"],
      },
      detection: [
        {
          projectRoot: "web",
          status: "available",
          executableConfig: true,
          configPaths: ["web/prettier.config.js"],
        },
      ],
      projectRoots: ["web"],
    },
    invocationTrust: false,
  };
}

describe("shared init selection policy", () => {
  it.each([undefined, "copy", "project", "managed", "off"] as const)(
    "generates identical selected bytes and consent for initial and interactive %s",
    (formatting) => {
      const base = context();
      const initial = {
        profile: "recommended" as const,
        formatting,
        projectTrust: true,
        evaluatedImport: evaluated,
      };
      const commandContext = {
        ...base,
        defaults: { ...base.defaults, ...initial },
      };
      const initialOptions = buildInitSelectionOptions(commandContext, initial);
      const interactiveOptions = buildInitSelectionOptions(base, {
        ...initial,
        hook: "none",
        scope: "projects",
        workflow: "none",
      });
      expect(interactiveOptions).toEqual(initialOptions);
      const commandProposal = createInitProposal(inspection, initialOptions);
      const interactiveProposal = createInitProposal(
        inspection,
        interactiveOptions,
      );
      expect(interactiveProposal).toEqual(commandProposal);
      expect(commandProposal.files[0]?.after).toBeTruthy();
      if (formatting !== "copy")
        expect(commandProposal.executableEvaluatedConfigs).toBeUndefined();
    },
  );

  it("requires an existing, invocation or selected grant for project execution", () => {
    const base = context();
    const selection = {
      profile: "recommended" as const,
      formatting: "project" as const,
    };
    expect(
      buildInitSelectionOptions(base, selection).projectPrettierTrustConfirmed,
    ).toBeUndefined();
    expect(
      buildInitSelectionOptions(base, { ...selection, projectTrust: true })
        .projectPrettierTrustRoots,
    ).toEqual(["web"]);
    const stored = {
      ...base,
      defaults: { ...base.defaults, projectTrust: true },
    };
    expect(
      buildInitSelectionOptions(stored, selection)
        .projectPrettierTrustConfirmed,
    ).toBe(true);
    expect(
      buildInitSelectionOptions(stored, { ...selection, projectTrust: false })
        .projectPrettierTrustConfirmed,
    ).toBeUndefined();
    expect(
      buildInitSelectionOptions({ ...base, invocationTrust: true }, selection)
        .projectPrettierTrustConfirmed,
    ).toBe(true);
  });

  it("keeps byte provenance paired with the accepted import and preserves unevaluated limitations", () => {
    const base = context();
    const selection = {
      profile: "recommended" as const,
      formatting: "copy" as const,
    };
    const plain = buildInitSelectionOptions(base, selection);
    expect(plain.formattingImport).toEqual(base.formatting.imported);
    expect(plain.executableEvaluatedConfigs).toBeUndefined();
    const imported = buildInitSelectionOptions(base, {
      ...selection,
      evaluatedImport: evaluated,
    });
    expect(imported.formattingImport).toBe(evaluated.imported);
    expect(imported.executableEvaluatedConfigs).toBe(
      evaluated.evaluatedConfigs,
    );
    expect(imported.projectPrettierTrustConfirmed).toBeUndefined();
  });

  it.each(["managed", "off"] as const)(
    "withdraws every discovered grant for %s without propagating evaluated bindings",
    (formatting) => {
      const base = context();
      const selected = buildInitSelectionOptions(base, {
        profile: "recommended",
        formatting,
        evaluatedImport: evaluated,
        projectTrust: true,
      });
      expect(selected.projectPrettierRevokeRoots).toEqual(["web"]);
      expect(selected.projectPrettierTrustConfirmed).toBeUndefined();
      expect(selected.formattingImport).toBeUndefined();
      expect(selected.executableEvaluatedConfigs).toBeUndefined();
    },
  );
});
