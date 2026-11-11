import { applyInitProposal } from "../../src/init/write-config.js";
import { hasProjectEslintTrust } from "../../src/checks/eslint/project/trust.js";
import { createGitRepository } from "../helpers/git-repository.js";
import { describe, expect, it } from "vitest";
import { createInitProposal } from "../../src/init/recommend.js";
import type { RepositoryInspection } from "../../src/inspection/types.js";
const inspection: RepositoryInspection = {
  snapshotRoot: "/repo",
  packageManager: "npm",
  lockfiles: [],
  workspaces: [
    {
      relativeRoot: ".",
      manifestPath: "package.json",
      sourceFiles: ["index.ts"],
      environments: ["typescript"],
      tsconfigPaths: [],
      dependencyDeclarations: [],
    },
  ],
};
const options = {
  repositoryRoot: "/repo",
  profile: "recommended" as const,
  hook: "none" as const,
};
describe("ESLint setup proposal", () => {
  it("keeps managed defaults and previews experimental project ownership", () => {
    expect(createInitProposal(inspection, options).eslintEngine).toBe(
      "managed",
    );
    const proposal = createInitProposal(inspection, {
      ...options,
      eslintEngine: "project",
    });
    expect(JSON.parse(proposal.files[0]!.after).checks.lint.engine).toBe(
      "project",
    );
    expect(proposal.eslintConflicts).toEqual([]);
    expect(proposal.projectEslintTrustRoots).toEqual(["."]);
    expect(proposal.limitations.join(" ")).toMatch(
      /experimental.*React.*accessibility/iu,
    );
    expect(proposal.projectEslintTrustConfirmed).not.toBe(true);
    expect(proposal.projectEslintMessagesConfirmed).not.toBe(true);
  });
  it("preserves existing project selection during repeated interactive setup", () => {
    const first = createInitProposal(inspection, {
      ...options,
      eslintEngine: "project",
    });
    const repeated = createInitProposal(inspection, {
      ...options,
      configBefore: first.files[0]!.after,
      checks: ["lint"],
    });
    expect(repeated.eslintEngine).toBe("project");
    expect(repeated.eslintConflicts).toEqual([]);
    expect(JSON.parse(repeated.files[0]!.after).checks.lint.engine).toBe(
      "project",
    );
  });
  it("previews a disabled lint conflict when a user deselects lint in existing project mode", () => {
    const first = createInitProposal(inspection, {
      ...options,
      eslintEngine: "project",
    });
    const repeated = createInitProposal(inspection, {
      ...options,
      configBefore: first.files[0]!.after,
      checks: [],
    });
    expect(JSON.parse(repeated.files[0]!.after).checks.lint).toMatchObject({
      engine: "project",
      severity: "off",
    });
    expect(repeated.eslintConflicts?.length).toBeGreaterThan(0);
  });
  it("preserves disabled lint and managed overrides for conflict review", () => {
    const before = JSON.stringify({
      schemaVersion: 1,
      checks: {
        lint: "off",
        reactAccessibility: { settings: { components: { Photo: "img" } } },
      },
    });
    const proposal = createInitProposal(inspection, {
      ...options,
      configBefore: before,
      checks: ["lint"],
      eslintEngine: "project",
    });
    expect(JSON.parse(proposal.files[0]!.after).checks.lint).toMatchObject({
      severity: "off",
      engine: "project",
    });
    expect(
      JSON.parse(proposal.files[0]!.after).checks.reactAccessibility.settings
        .components,
    ).toEqual({ Photo: "img" });
    expect(proposal.eslintConflicts?.length).toBeGreaterThan(0);
  });
  it("keeps execution consent separate from full diagnostic message consent", () => {
    const proposal = createInitProposal(inspection, {
      ...options,
      eslintEngine: "project",
      projectEslintTrustConfirmed: true,
      projectEslintMessagesConfirmed: false,
    });
    expect(proposal.projectEslintTrustConfirmed).toBe(true);
    expect(proposal.projectEslintMessagesConfirmed).not.toBe(true);
    expect(
      JSON.parse(proposal.files[0]!.after).reporting.projectEslintMessages,
    ).not.toBe("full");
    const full = createInitProposal(inspection, {
      ...options,
      eslintEngine: "project",
      projectEslintMessages: "full",
      projectEslintMessagesConfirmed: true,
    });
    expect(
      JSON.parse(full.files[0]!.after).reporting.projectEslintMessages,
    ).toBe("full");
    expect(full.projectEslintTrustConfirmed).not.toBe(true);
  });
  it("requires execution consent to apply and does not grant message permission implicitly", async () => {
    const repo = await createGitRepository("zedbee-init-eslint-");
    const proposal = createInitProposal(inspection, {
      ...options,
      repositoryRoot: repo.root,
      eslintEngine: "project",
    });
    await expect(applyInitProposal(proposal)).rejects.toThrow(
      /consent|trust/iu,
    );
    await expect(
      hasProjectEslintTrust(repo.root, ".", "execute"),
    ).resolves.toBe(false);
    await applyInitProposal({ ...proposal, projectEslintTrustConfirmed: true });
    await expect(
      hasProjectEslintTrust(repo.root, ".", "execute"),
    ).resolves.toBe(true);
    await expect(
      hasProjectEslintTrust(repo.root, ".", "messages"),
    ).resolves.toBe(false);
  });
});
