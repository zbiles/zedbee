import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { loadConfig } from "../../src/config/load-config.js";

async function createRepositoryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "zedbee-config-test-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  return root;
}

describe("loadConfig", () => {
  it("uses the recommended profile when no config exists", async () => {
    const root = await createRepositoryRoot();

    const config = await loadConfig(root);

    expect(config.schemaVersion).toBe(1);
    expect(config.profile).toBe("recommended");
    expect(config.checks.formatting).toEqual({
      severity: "error",
      when: "relevant",
    });
    expect(config.checks.types).toEqual({
      severity: "error",
      when: "relevant",
    });
    expect(config.checks.duplication).toEqual({
      severity: "off",
      when: "relevant",
      threshold: 5,
    });
    expect(config.failOnIncomplete).toBe(true);
    expect(config.overrides).toEqual([]);
  });

  it("parses comments and applies per-check overrides", async () => {
    const root = await createRepositoryRoot();
    const configPath = join(root, ".zedbeerc.jsonc");
    await writeFile(
      configPath,
      `{
        // Repository policy
        "schemaVersion": 1,
        "profile": "fast",
        "checks": {
          "formatting": { "severity": "warn", "when": "always" }
        }
      }`,
    );

    const config = await loadConfig(root);

    expect(config.schemaVersion).toBe(1);
    expect(config.profile).toBe("fast");
    expect(config.checks.formatting).toEqual({
      severity: "warn",
      when: "always",
    });
    expect(config.checks.types).toEqual({ severity: "off", when: "relevant" });
    expect(config.failOnIncomplete).toBe(true);
    expect(config.overrides).toEqual([]);
    expect(config.configPath).toBe(configPath);
  });

  it("supports severity shorthand and fail-open override", async () => {
    const root = await createRepositoryRoot();
    await writeFile(
      join(root, ".zedbeerc.jsonc"),
      JSON.stringify({
        schemaVersion: 1,
        profile: "thorough",
        checks: { formatting: "off" },
        failOnIncomplete: false,
      }),
    );

    const config = await loadConfig(root);

    expect(config.checks.formatting).toEqual({
      severity: "off",
      when: "relevant",
    });
    expect(config.failOnIncomplete).toBe(false);
  });

  it("loads an explicit JSONC path selected by the CLI", async () => {
    const root = await createRepositoryRoot();
    const configPath = join(root, "config", "zedbee.jsonc");
    await mkdir(join(root, "config"), { recursive: true });
    await writeFile(
      configPath,
      '{"schemaVersion":1,"profile":"fast","checks":{"formatting":"warn"}}',
    );

    const config = await loadConfig(root, configPath);

    expect(config.profile).toBe("fast");
    expect(config.checks.formatting.severity).toBe("warn");
    expect(config.configPath).toBe(configPath);
  });

  it("accepts only the supported option fields for each managed check", async () => {
    const root = await createRepositoryRoot();
    await writeFile(
      join(root, ".zedbeerc.jsonc"),
      JSON.stringify({
        schemaVersion: 1,
        checks: {
          lint: { when: "always" },
          cyclomaticComplexity: { max: 20, blockWorsening: true },
          readabilityComplexity: {
            severity: "warn",
            max: 15,
            blockWorsening: false,
          },
          duplication: { threshold: 5 },
          vulnerabilities: { network: "offline" },
        },
      }),
    );

    const config = await loadConfig(root);

    expect(config.checks.lint).toEqual({ severity: "error", when: "always" });
    expect(config.checks.cyclomaticComplexity).toEqual({
      severity: "error",
      when: "relevant",
      max: 20,
      blockWorsening: true,
    });
    expect(config.checks.readabilityComplexity).toEqual({
      severity: "warn",
      when: "relevant",
      max: 15,
      blockWorsening: false,
    });
    expect(config.checks.duplication).toEqual({
      severity: "off",
      when: "relevant",
      threshold: 5,
    });
    expect(config.checks.vulnerabilities).toEqual({
      severity: "off",
      when: "relevant",
      network: "offline",
    });
  });

  it.each([
    ".zedbeerc.js",
    ".zedbeerc.cjs",
    ".zedbeerc.mjs",
    ".zedbeerc.ts",
    ".zedbeerc.json",
  ])("rejects unsupported configuration file %s", async (filename) => {
    const root = await createRepositoryRoot();
    await writeFile(join(root, filename), "export default {};\n");

    await expect(loadConfig(root)).rejects.toMatchObject({
      code: "CONFIG_UNSUPPORTED",
    });
  });

  it.each([
    {
      name: "unsupported schema version",
      source: '{"schemaVersion":2,"profile":"fast"}',
    },
    {
      name: "unknown check",
      source: '{"schemaVersion":1,"checks":{"mystery":"error"}}',
    },
    {
      name: "invalid severity",
      source: '{"schemaVersion":1,"checks":{"formatting":"fatal"}}',
    },
    {
      name: "invalid duplication threshold",
      source:
        '{"schemaVersion":1,"checks":{"duplication":{"severity":"error","threshold":-1}}}',
    },
    {
      name: "threshold on a check that does not support it",
      source:
        '{"schemaVersion":1,"checks":{"lint":{"severity":"error","threshold":5}}}',
    },
    {
      name: "invalid vulnerability network mode",
      source:
        '{"schemaVersion":1,"checks":{"vulnerabilities":{"severity":"error","network":"sometimes"}}}',
    },
    {
      name: "network mode on a non-vulnerability check",
      source:
        '{"schemaVersion":1,"checks":{"structuralSecurity":{"severity":"error","network":"offline"}}}',
    },
    {
      name: "unknown per-check option",
      source:
        '{"schemaVersion":1,"checks":{"cyclomaticComplexity":{"severity":"error","maximum":20}}}',
    },
    {
      name: "malformed JSONC",
      source: '{"schemaVersion":1,"checks":',
    },
  ])("rejects $name without echoing source", async ({ source }) => {
    const root = await createRepositoryRoot();
    await writeFile(join(root, ".zedbeerc.jsonc"), source);

    const error = await loadConfig(root).catch((reason: unknown) => reason);

    expect(error).toMatchObject({ code: "CONFIG_INVALID" });
    expect(String(error)).not.toContain(source);
  });

  it.each([
    {
      name: "missing files",
      override: { checks: { lint: "warn" } },
    },
    {
      name: "empty files",
      override: { files: [], checks: { lint: "warn" } },
    },
    {
      name: "empty pattern",
      override: { files: [""], checks: { lint: "warn" } },
    },
    {
      name: "parent traversal",
      override: { files: ["packages/../outside/**"], checks: { lint: "warn" } },
    },
    {
      name: "POSIX absolute path",
      override: { files: ["/packages/web/**"], checks: { lint: "warn" } },
    },
    {
      name: "Windows drive path",
      override: { files: ["C:/packages/web/**"], checks: { lint: "warn" } },
    },
    {
      name: "Windows UNC path",
      override: { files: ["//server/share/**"], checks: { lint: "warn" } },
    },
    {
      name: "backslash-obscured traversal",
      override: {
        files: ["packages\\..\\outside\\**"],
        checks: { lint: "warn" },
      },
    },
    {
      name: "unknown check",
      override: { files: ["packages/web/**"], checks: { mystery: "warn" } },
    },
    {
      name: "file-scoped network policy",
      override: {
        files: ["packages/web/**"],
        checks: { vulnerabilities: { network: "online" } },
      },
    },
  ])("rejects an override with $name", async ({ override }) => {
    const root = await createRepositoryRoot();
    await writeFile(
      join(root, ".zedbeerc.jsonc"),
      JSON.stringify({ schemaVersion: 1, overrides: [override] }),
    );

    await expect(loadConfig(root)).rejects.toMatchObject({
      code: "CONFIG_INVALID",
    });
  });

  it("preserves override declaration order, safe globs, and explicit patch fields", async () => {
    const root = await createRepositoryRoot();
    await writeFile(
      join(root, ".zedbeerc.jsonc"),
      JSON.stringify({
        schemaVersion: 1,
        overrides: [
          {
            files: ["packages/web/**", "apps/*/src/**/*.tsx"],
            checks: {
              reactAccessibility: "warn",
              cyclomaticComplexity: { max: 25 },
            },
          },
          {
            files: ["packages/web/test/**"],
            checks: {
              reactAccessibility: { when: "always" },
              cyclomaticComplexity: { blockWorsening: false },
            },
          },
        ],
      }),
    );

    const config = await loadConfig(root);

    expect(config.overrides).toEqual([
      {
        files: ["packages/web/**", "apps/*/src/**/*.tsx"],
        checks: {
          cyclomaticComplexity: { max: 25 },
          reactAccessibility: { severity: "warn" },
        },
      },
      {
        files: ["packages/web/test/**"],
        checks: {
          cyclomaticComplexity: { blockWorsening: false },
          reactAccessibility: { when: "always" },
        },
      },
    ]);
  });
});
