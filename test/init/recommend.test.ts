import { describe, expect, it } from "vitest";
import { createInitProposal } from "../../src/init/recommend.js";
import type { RepositoryInspection } from "../../src/inspection/types.js";

function inspection(
  environments: RepositoryInspection["workspaces"][number]["environments"],
  options: { monorepo?: boolean; lockfile?: boolean } = {},
): RepositoryInspection {
  const workspace = (relativeRoot: string) => ({
    relativeRoot,
    manifestPath:
      relativeRoot === "." ? "package.json" : `${relativeRoot}/package.json`,
    sourceFiles: [`${relativeRoot === "." ? "src" : relativeRoot}/app.tsx`],
    tsconfigPaths: environments.includes("typescript")
      ? [`${relativeRoot === "." ? "" : `${relativeRoot}/`}tsconfig.json`]
      : [],
    environments,
  });
  return {
    snapshotRoot: "/repo",
    packageManager: options.lockfile === true ? "npm" : "unknown",
    lockfiles: options.lockfile === true ? ["package-lock.json"] : [],
    workspaces:
      options.monorepo === true
        ? [workspace("."), workspace("packages/app")]
        : [workspace(".")],
  };
}

describe("createInitProposal", () => {
  it("recommends TypeScript and browser React checks from inspected environments", () => {
    const proposal = createInitProposal(
      inspection(["javascript", "typescript", "react", "react-dom"]),
      { repositoryRoot: "/repo", profile: "recommended", hook: "none" },
    );

    expect(proposal.detectedEnvironments).toEqual([
      "javascript",
      "typescript",
      "react",
      "react-dom",
    ]);
    expect(proposal.recommendedChecks).toEqual(
      expect.arrayContaining([
        "types",
        "reactCorrectness",
        "reactAccessibility",
      ]),
    );
  });

  it("recommends React correctness but not browser accessibility for Ink", () => {
    const proposal = createInitProposal(
      inspection(["javascript", "typescript", "react", "ink"]),
      { repositoryRoot: "/repo", profile: "recommended", hook: "none" },
    );

    expect(proposal.recommendedChecks).toContain("reactCorrectness");
    expect(proposal.recommendedChecks).not.toContain("reactAccessibility");
  });

  it("recommends architecture and vulnerability coverage when inspection supports them", () => {
    const proposal = createInitProposal(
      inspection(["javascript"], { monorepo: true, lockfile: true }),
      { repositoryRoot: "/repo", profile: "thorough", hook: "none" },
    );

    expect(proposal.recommendedChecks).toEqual(
      expect.arrayContaining(["dependencyArchitecture", "vulnerabilities"]),
    );
    expect(proposal.networkChecks).toEqual([
      expect.objectContaining({
        id: "vulnerabilities",
        usesNetwork: true,
        disclosure:
          "Online vulnerability checks send package names, versions, ecosystems, and supported file hashes to api.osv.dev and api.deps.dev; source code is not sent.",
      }),
    ]);
  });

  it("produces deterministic config content, hashes, and an exact preview", () => {
    const proposal = createInitProposal(inspection(["javascript"]), {
      repositoryRoot: "/repo",
      profile: "fast",
      hook: "none",
    });

    expect(proposal.files).toHaveLength(1);
    expect(proposal.files[0]).toMatchObject({
      relativePath: ".zedbeerc.jsonc",
      beforeHash: null,
      afterHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      after: expect.stringContaining('"profile": "fast"'),
      diff: expect.stringContaining("+++ .zedbeerc.jsonc"),
    });
  });

  it("updates an existing JSONC profile without discarding comments or check choices", () => {
    const before = [
      "{",
      "  // Keep the team's explicit policy.",
      '  "schemaVersion": 1,',
      '  "profile": "fast",',
      '  "checks": { "secrets": "off" }',
      "}",
      "",
    ].join("\n");

    const proposal = createInitProposal(inspection(["javascript"]), {
      repositoryRoot: "/repo",
      profile: "thorough",
      hook: "none",
      configBefore: before,
    });

    expect(proposal.files[0]?.after).toContain(
      "Keep the team's explicit policy",
    );
    expect(proposal.files[0]?.after).toContain('"secrets": "off"');
    expect(proposal.files[0]?.after).toContain('"profile": "thorough"');
  });

  it("serializes explicit check toggles for the non-interactive equivalent", () => {
    const proposal = createInitProposal(
      inspection(["javascript", "typescript"]),
      {
        repositoryRoot: "/repo",
        profile: "recommended",
        hook: "none",
        checks: ["lint", "types"],
      },
    );

    expect(proposal.recommendedChecks).toEqual(["lint", "types"]);
    expect(proposal.files[0]?.after).toContain('"lint": "error"');
    expect(proposal.files[0]?.after).toContain('"types": "error"');
    expect(proposal.files[0]?.after).toContain('"formatting": "off"');
  });
});
