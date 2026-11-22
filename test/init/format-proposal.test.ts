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
      "checks": { "formatting": "warn" }
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
      expect(
        overrides.filter((entry: { generated?: string }) => !entry.generated),
      ).toEqual([
        { files: ["docs/**"], checks: { secrets: "warn" } },
        { files: ["tests/**"], checks: { formatting: "warn" } },
      ]);
      const generated = overrides.filter(
        (entry: { generated?: string }) => entry.generated === "prettier-scope",
      );
      if (formattingScope === "projects")
        expect(overrides[1]).toBe(generated[0]);
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
      expect(
        policy(after)("formatting", "tests/example.ts", "target").severity,
      ).toBe("warn");
      const repeated = await formatInitProposal(
        createInitProposal(inspection, { ...selected, configBefore: after }),
      );
      expect(repeated.files[0]!.after).toBe(after);
    },
  );
  it("keeps a standalone comment above a handwritten override when generated scope is removed", async () => {
    const before = `{
      "schemaVersion": 1,
      "overrides": [
        {"files":["**"],"excludeFiles":["web/**"],"checks":{"formatting":"off"},"generated":"prettier-scope"},
        // Explanation for the handwritten override.
        {"files":["docs/**"],"checks":{"formatting":"warn"}}
      ]
    }\n`;
    const proposal = await formatInitProposal(
      createInitProposal(inspection, {
        ...options,
        configBefore: before,
        formatting: "managed",
        formattingScope: "repository",
      }),
    );
    expect(proposal.files[0]!.after).toContain(
      "// Explanation for the handwritten override.",
    );
  });

  it("respects updated Prettier import precedence inside the generated slots", () => {
    const specific = {
      files: ["src/**"],
      excludeFiles: [],
      settings: { tabWidth: 4 },
    };
    const general = {
      files: ["**/*.ts"],
      excludeFiles: [],
      settings: { tabWidth: 6 },
    };
    const copied = {
      ...options,
      formatting: "copy" as const,
      configBefore:
        '{"schemaVersion":1,"overrides":[{"files":["docs/**"],"checks":{"lint":"warn"}}]}',
      formattingImport: {
        settings: {},
        overrides: [specific, general],
        limitations: [],
      },
    };
    const initial = createInitProposal(inspection, copied).files[0]!.after;
    const overrides = parse(initial).overrides;
    const before = JSON.stringify({
      ...parse(initial),
      overrides: [overrides[1], overrides[0], overrides[2]],
    });
    const after = createInitProposal(inspection, {
      ...copied,
      configBefore: before,
      formattingImport: {
        ...copied.formattingImport,
        overrides: [general, specific],
      },
    }).files[0]!.after;
    expect(
      parse(after).overrides.map(
        (entry: { files: string[] }) => entry.files[0],
      ),
    ).toEqual(["**/*.ts", "docs/**", "src/**"]);
    expect(
      policy(after)("formatting", "src/example.ts", "target"),
    ).toMatchObject({ settings: { tabWidth: 4 } });
  });

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
