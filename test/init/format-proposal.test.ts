import { describe, expect, it } from "vitest";
import { format } from "prettier";
import { parse } from "jsonc-parser";
import { createInitProposal } from "../../src/init/recommend.js";
import { formatInitProposal } from "../../src/init/format-proposal.js";
import { DEFAULT_FORMATTING_SETTINGS } from "../../src/checks/prettier/settings.js";
import { configFileSchema } from "../../src/config/schema.js";
import { resolveConfig } from "../../src/config/profiles.js";
import { createFilePolicyResolver } from "../../src/config/file-policy.js";
import type { RepositoryInspection } from "../../src/inspection/types.js";
const inspection: RepositoryInspection = {
  snapshotRoot: "/repo",
  packageManager: "npm",
  lockfiles: [],
  workspaces: [],
};
const options = {
  repositoryRoot: "/repo",
  profile: "recommended" as const,
  hook: "none" as const,
  formatting: "project" as const,
  formattingProjectRoots: ["web"],
  formattingRootProject: false,
};
function policy(after: string) {
  return createFilePolicyResolver(
    resolveConfig(configFileSchema.parse(parse(after))),
    { files: new Map(), isEmpty: true, containsAddedLine: () => false },
  );
}
describe("setup formatting", () => {
  it("keeps root project source native and setup data managed across repeat review", async () => {
    const rootOptions = {
      ...options,
      formattingProjectRoots: [],
      formattingRootProject: true,
      formattingScope: "repository" as const,
      formattingScopeRoots: ["."],
    };
    const before = `{
      "schemaVersion": 1,
      "overrides": [{
        // Keep this existing override explanation.
        "files": ["docs/**"], "checks": {"secrets": "warn"}
      }]
    }\n`;
    const proposal = await formatInitProposal(
      createInitProposal(inspection, {
        ...rootOptions,
        configBefore: before,
      }),
    );
    const file = proposal.files[0]!;
    const resolve = policy(file.after);
    expect(resolve("formatting", ".zedbeerc.jsonc", "target").engine).toBe(
      "managed",
    );
    expect(resolve("formatting", "src/app.ts", "target").engine).toBe(
      "project",
    );
    expect(file.after).toContain("// Keep this existing override explanation.");
    expect(file.after).toBe(
      await format(file.after, {
        ...DEFAULT_FORMATTING_SETTINGS,
        parser: "json",
      }),
    );
    expect((await formatInitProposal(proposal)).files[0]).toEqual(file);
    const repeated = await formatInitProposal(
      createInitProposal(inspection, {
        ...rootOptions,
        configBefore: file.after,
      }),
    );
    expect(repeated.files[0]!.after).toBe(file.after);
  });
  it.each(["projects", "repository"] as const)(
    "preserves comments inside user overrides while replacing %s scope entries",
    async (formattingScope) => {
      const before = `{
  "schemaVersion": 1,
  "overrides": [
    {
      // Keep the docs policy rationale.
      "files": ["docs/**"],
      "checks": { "secrets": "warn" }
    },
    {
      "files": ["**"], "excludeFiles": ["old/**"],
      "checks": { "formatting": "off" }, "generated": "prettier-scope"
    },
    {
      /* Keep the tests policy rationale. */
      "files": ["tests/**"],
      "checks": { "lint": "warn" }
    }
  ]
}\n`;
      const selected = {
        repositoryRoot: "/repo",
        profile: "recommended" as const,
        hook: "none" as const,
        formatting: "managed" as const,
        formattingScope,
        formattingScopeRoots: ["web"],
      };
      const proposal = await formatInitProposal(
        createInitProposal(inspection, { ...selected, configBefore: before }),
      );
      const after = proposal.files[0]!.after;
      expect(after).toContain("// Keep the docs policy rationale.");
      expect(after).toContain("/* Keep the tests policy rationale. */");
      const overrides = parse(after).overrides;
      expect(overrides.slice(0, 2)).toEqual([
        { files: ["docs/**"], checks: { secrets: "warn" } },
        { files: ["tests/**"], checks: { lint: "warn" } },
      ]);
      const generated = overrides.filter(
        (entry: { generated?: string }) => entry.generated === "prettier-scope",
      );
      expect(generated).toEqual(
        formattingScope === "projects"
          ? [
              {
                files: ["**"],
                excludeFiles: ["web/**"],
                checks: { formatting: "off" },
                generated: "prettier-scope",
              },
            ]
          : [],
      );
      const repeated = await formatInitProposal(
        createInitProposal(inspection, { ...selected, configBefore: after }),
      );
      expect(repeated.files[0]!.after).toBe(after);
    },
  );
  it("formats nested generated configuration before its exact preview and hashes", async () => {
    const proposal = await formatInitProposal(
      createInitProposal(inspection, options),
    );
    const file = proposal.files[0]!;
    expect(file.after).toBe(
      await format(file.after, {
        ...DEFAULT_FORMATTING_SETTINGS,
        parser: "json",
      }),
    );
    expect(file.diff).toContain('+      "files": ["web/**"],');
    expect((await formatInitProposal(proposal)).files[0]).toEqual(file);
  });
  it("preserves JSONC comments and user policy when formatting updated setup", async () => {
    const before =
      '{\n // Keep this explanation\n "schemaVersion":1, "checks":{"secrets":"warn"}\n}\n';
    const proposal = await formatInitProposal(
      createInitProposal(inspection, { ...options, configBefore: before }),
    );
    expect(proposal.files[0]!.before).toBe(before);
    expect(proposal.files[0]!.after).toContain("// Keep this explanation");
    expect(parse(proposal.files[0]!.after).checks.secrets).toBe("warn");
  });
  it("limits formatting to detected folders while leaving other checks enabled", () => {
    const proposal = createInitProposal(inspection, {
      ...options,
      formattingScope: "projects",
      formattingScopeRoots: ["web"],
    });
    const resolve = policy(proposal.files[0]!.after);
    expect(resolve("formatting", "web/app.tsx", "target").severity).toBe(
      "error",
    );
    expect(
      resolve("formatting", "api/domain/xray/rules/AGENTS.md", "target")
        .severity,
    ).toBe("off");
    expect(resolve("lint", "api/example.ts", "target").severity).toBe("error");
  });
  it("restores repository scope on repeat setup and preserves user overrides", () => {
    const before = createInitProposal(inspection, {
      ...options,
      formattingScope: "projects",
      formattingScopeRoots: ["web"],
      configBefore:
        '{"schemaVersion":1,"overrides":[{"files":["docs/**"],"checks":{"secrets":"warn"}}]}',
    }).files[0]!.after;
    const proposal = createInitProposal(inspection, {
      ...options,
      configBefore: before,
      formattingScope: "repository",
      formattingScopeRoots: ["web"],
    });
    expect(
      policy(proposal.files[0]!.after)("formatting", "api/AGENTS.md", "target")
        .severity,
    ).toBe("error");
    expect(parse(proposal.files[0]!.after).overrides).toContainEqual({
      files: ["docs/**"],
      checks: { secrets: "warn" },
    });
  });
});
