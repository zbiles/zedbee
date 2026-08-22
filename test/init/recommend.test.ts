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
    dependencyDeclarations: [],
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
        onUnavailable: "block",
        disclosure:
          "Online vulnerability checks send package names, exact versions, and ecosystem identifiers to api.osv.dev; source code and file hashes are not sent.",
      }),
    ]);
    expect(proposal.files[0]?.after).toContain('"onUnavailable": "block"');
  });

  it("writes the selected OSV outage behavior and omits disclosure when vulnerability scanning is off", () => {
    const warn = createInitProposal(
      inspection(["javascript"], { lockfile: true }),
      {
        repositoryRoot: "/repo",
        profile: "thorough",
        hook: "none",
        osvUnavailable: "warn",
      },
    );
    expect(warn.osvUnavailable).toBe("warn");
    expect(warn.files[0]?.after).toContain('"onUnavailable": "warn"');

    const disabled = createInitProposal(
      inspection(["javascript"], { lockfile: true }),
      {
        repositoryRoot: "/repo",
        profile: "thorough",
        hook: "none",
        checks: ["lint"],
        osvUnavailable: "warn",
      },
    );
    expect(disabled.networkChecks).toEqual([]);
    expect(disabled.files[0]?.after).not.toContain("onUnavailable");
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
    expect(proposal.files[0]?.after).toContain(
      '"opening": "Use the complete JSON report as the source of truth. Do not rely only on this terminal summary. Follow the report outcome and review all recorded details."',
    );
    expect(proposal.files[0]?.after).toContain(
      '"nextStep": "Fix every blocking finding, review warnings separately, and resolve any incomplete checks. Stage any changes and run Zedbee again. Do not bypass the pre-commit hook."',
    );
    expect(proposal.files[0]?.after).toContain(
      '"$schema": "./node_modules/zedbee/schema/zedbee.schema.json"',
    );
    for (const expandedSetting of [
      '"settings"',
      '"rules"',
      '"max"',
      '"blockWorsening"',
      '"threshold"',
      '"minLines"',
      '"minTokens"',
    ]) {
      expect(proposal.files[0]?.after).not.toContain(expandedSetting);
    }
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

  it("preserves omitted and explicitly blank existing agent guidance", () => {
    const omitted = createInitProposal(inspection(["javascript"]), {
      repositoryRoot: "/repo",
      profile: "thorough",
      hook: "none",
      configBefore: '{ "schemaVersion": 1 }\n',
    });
    expect(omitted.files[0]?.after).not.toContain("agentGuidance");

    const blank = createInitProposal(inspection(["javascript"]), {
      repositoryRoot: "/repo",
      profile: "thorough",
      hook: "none",
      configBefore:
        '{ "schemaVersion": 1, "reporting": { "agentGuidance": { "opening": "", "nextStep": "" } } }\n',
    });
    expect(blank.files[0]?.after).toContain('"opening": ""');
    expect(blank.files[0]?.after).toContain('"nextStep": ""');
    expect(blank.files[0]?.after).not.toContain(
      "Use the complete JSON report as the source of truth.",
    );
  });

  it("preserves shorthand vulnerability severity while adding outage policy", () => {
    const before = [
      "{",
      '  "schemaVersion": 1,',
      '  "profile": "thorough",',
      '  "checks": { "vulnerabilities": "warn" }',
      "}",
      "",
    ].join("\n");

    const proposal = createInitProposal(
      inspection(["javascript"], { lockfile: true }),
      {
        repositoryRoot: "/repo",
        profile: "thorough",
        hook: "none",
        osvUnavailable: "warn",
        configBefore: before,
      },
    );

    expect(proposal.files[0]?.after).toContain(
      '"vulnerabilities": {\n      "severity": "warn",\n      "onUnavailable": "warn"',
    );

    const disabled = createInitProposal(
      inspection(["javascript"], { lockfile: true }),
      {
        repositoryRoot: "/repo",
        profile: "thorough",
        hook: "none",
        configBefore: before.replace('"warn"', '"off"'),
      },
    );
    expect(disabled.networkChecks).toEqual([]);
    expect(disabled.files[0]?.after).toContain('"vulnerabilities": "off"');
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
