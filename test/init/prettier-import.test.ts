import { cp, lstat, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFilePolicyResolver } from "../../src/config/file-policy.js";
import { resolveConfig } from "../../src/config/profiles.js";
import * as prettier from "prettier";
import { DEFAULT_FORMATTING_SETTINGS } from "../../src/checks/prettier/settings.js";
import { previewPrettierSettingsImport } from "../../src/init/prettier-import.js";
import { createInspectionFixture } from "../inspection/fixture.js";

async function markerExists(root: string, name: string): Promise<boolean> {
  try {
    await lstat(join(root, name));
    return true;
  } catch {
    return false;
  }
}

describe("previewPrettierSettingsImport", () => {
  it("copies supported literal settings from JSON", async () => {
    const fixture = await createInspectionFixture();
    await fixture.writeJson("package.json", { name: "app" });
    await fixture.write(
      ".prettierrc.json",
      JSON.stringify({ printWidth: 100, trailingComma: "es5" }),
    );

    const preview = await previewPrettierSettingsImport(fixture.root);

    expect(preview.settings).toEqual({
      printWidth: 100,
      trailingComma: "es5",
    });
    expect(preview.limitations).toEqual([]);
  });

  it("copies settings from package.json#prettier", async () => {
    const fixture = await createInspectionFixture();
    await fixture.writeJson("package.json", {
      name: "app",
      prettier: { printWidth: 90, singleQuote: true },
    });

    const preview = await previewPrettierSettingsImport(fixture.root);

    expect(preview.settings).toEqual({ printWidth: 90, singleQuote: true });
  });

  it("preserves scoped overrides in order", async () => {
    const fixture = await createInspectionFixture();
    await fixture.writeJson("package.json", { name: "app" });
    await fixture.write(
      ".prettierrc.json",
      JSON.stringify({
        printWidth: 100,
        trailingComma: "es5",
        overrides: [{ files: "*.md", options: { printWidth: 80 } }],
      }),
    );

    const preview = await previewPrettierSettingsImport(fixture.root);

    expect(preview.settings).toEqual({
      printWidth: 100,
      trailingComma: "es5",
    });
    expect(preview.overrides).toEqual([
      {
        files: ["**/*.md"],
        excludeFiles: [],
        settings: { printWidth: 80 },
      },
    ]);
  });

  it("translates basename override patterns relative to their config directory", async () => {
    const fixture = await createInspectionFixture();
    await fixture.writeJson("package.json", { name: "app" });
    await fixture.write(
      ".prettierrc.json",
      JSON.stringify({
        printWidth: 100,
        overrides: [{ files: "*.md", options: { printWidth: 80 } }],
      }),
    );

    const preview = await previewPrettierSettingsImport(fixture.root);

    expect(preview.overrides).toContainEqual({
      files: ["**/*.md"],
      excludeFiles: [],
      settings: { printWidth: 80 },
    });
  });

  it("reports plugins and unsupported options as limitations", async () => {
    const fixture = await createInspectionFixture();
    await fixture.writeJson("package.json", { name: "app" });
    await fixture.write(
      ".prettierrc.json",
      JSON.stringify({
        singleQuote: true,
        plugins: ["some-plugin"],
        parser: "babel",
      }),
    );

    const preview = await previewPrettierSettingsImport(fixture.root);

    expect(preview.settings).toEqual({ singleQuote: true });
    expect(preview.limitations.join("\n")).toMatch(/plugins/u);
    expect(preview.limitations.join("\n")).toMatch(/parser/u);
  });

  it("does not evaluate an executable config", async () => {
    const fixture = await createInspectionFixture();
    await fixture.writeJson("package.json", {
      name: "app",
      devDependencies: { prettier: "3.9.6" },
    });
    await fixture.write(
      "prettier.config.mjs",
      "import { writeFileSync } from 'node:fs';\n" +
        "writeFileSync(new URL('./MARKER_IMPORT', import.meta.url), 'executed');\n" +
        "export default { printWidth: 123 };\n",
    );

    const preview = await previewPrettierSettingsImport(fixture.root);

    expect(preview.settings).toEqual({});
    expect(preview.limitations.join("\n")).toMatch(/executable|shared/u);
    expect(await markerExists(fixture.root, "MARKER_IMPORT")).toBe(false);
  });

  it("uses Prettier's executable configuration precedence", async () => {
    const fixture = await createInspectionFixture();
    await fixture.writeJson("package.json", {
      name: "app",
      devDependencies: { prettier: "3.9.6" },
    });
    await fixture.write(".prettierrc.cjs", "module.exports = { semi: false };\n");
    await fixture.write(
      "prettier.config.js",
      "export default { singleQuote: true };\n",
    );

    const preview = await previewPrettierSettingsImport(fixture.root);

    expect(preview.executableConfigs).toEqual([
      { projectRoot: ".", configPath: "prettier.config.js" },
    ]);
  });

  it("uses Prettier 3.0 configuration precedence", async () => {
    const fixture = await createInspectionFixture();
    await fixture.writeJson("package.json", {
      name: "app",
      devDependencies: { prettier: "3.0.3" },
    });
    await mkdir(join(fixture.root, "node_modules"), { recursive: true });
    await cp(
      join(process.cwd(), "node_modules", "prettier-3-0-3"),
      join(fixture.root, "node_modules", "prettier"),
      { recursive: true },
    );
    await fixture.write(".prettierrc.cjs", "module.exports = { semi: false };\n");
    await fixture.write(
      "prettier.config.js",
      "export default { singleQuote: true };\n",
    );

    const preview = await previewPrettierSettingsImport(fixture.root);

    expect(preview.executableConfigs).toEqual([
      { projectRoot: ".", configPath: ".prettierrc.cjs" },
    ]);
  });

  it("uses an exact declared version when the formatter is not installed", async () => {
    const fixture = await createInspectionFixture();
    await fixture.writeJson("package.json", {
      name: "app",
      devDependencies: { prettier: "3.0.3" },
    });
    await fixture.write(".prettierrc.yaml", "semi: false\n");
    await fixture.write(".prettierrc.yml", "singleQuote: true\n");

    const preview = await previewPrettierSettingsImport(fixture.root);

    expect(preview.settings).toMatchObject({ semi: false });
    expect(preview.settings).not.toHaveProperty("singleQuote");
    expect(preview.limitations).toEqual([]);
  });

  it("reports ambiguous precedence without an installed formatter", async () => {
    const fixture = await createInspectionFixture();
    await fixture.writeJson("package.json", {
      name: "app",
      devDependencies: { prettier: ">=3.0.0 <4.0.0" },
    });
    await fixture.write(".prettierrc.yaml", "semi: false\n");
    await fixture.write(".prettierrc.yml", "singleQuote: true\n");

    const preview = await previewPrettierSettingsImport(fixture.root);

    expect(preview.settings).toEqual({});
    expect(preview.limitations).toContainEqual(
      expect.stringContaining("precedence"),
    );
  });

  it("selects package.yaml before executable configs when supported", async () => {
    const fixture = await createInspectionFixture();
    await fixture.writeJson("package.json", {
      name: "app",
      devDependencies: { prettier: "3.9.6" },
    });
    await mkdir(join(fixture.root, "node_modules"), { recursive: true });
    await cp(
      join(process.cwd(), "node_modules", "prettier"),
      join(fixture.root, "node_modules", "prettier"),
      { recursive: true },
    );
    await fixture.write("package.yaml", "prettier:\n  semi: false\n");
    await fixture.write(
      "prettier.config.js",
      "export default { singleQuote: true };\n",
    );

    const preview = await previewPrettierSettingsImport(fixture.root);

    expect(preview.settings).toMatchObject({ semi: false });
    expect(preview.executableConfigs).toEqual([]);
  });

  it("reports a selected package.yaml shared configuration target", async () => {
    const fixture = await createInspectionFixture();
    await fixture.writeJson("package.json", {
      name: "app",
      devDependencies: { prettier: "3.9.6" },
    });
    await mkdir(join(fixture.root, "node_modules"), { recursive: true });
    await cp(
      join(process.cwd(), "node_modules", "prettier"),
      join(fixture.root, "node_modules", "prettier"),
      { recursive: true },
    );
    await fixture.write(
      "package.yaml",
      "prettier: '@org/prettier-config'\n",
    );

    const preview = await previewPrettierSettingsImport(fixture.root);

    expect(preview.sharedConfigs).toEqual([
      {
        projectRoot: ".",
        configPath: "package.yaml",
        specifier: "@org/prettier-config",
      },
    ]);
    expect(preview.limitations).toContainEqual(
      expect.stringContaining("package.yaml Prettier field"),
    );
  });

  it("treats malformed configuration as a limitation, not a failure", async () => {
    const fixture = await createInspectionFixture();
    await fixture.writeJson("package.json", { name: "app" });
    await fixture.write(".prettierrc.json", "{ not valid json");

    const preview = await previewPrettierSettingsImport(fixture.root);

    expect(preview.settings).toEqual({});
    expect(preview.limitations.join("\n")).toMatch(/could not be parsed/u);
  });

  it("materializes a nested config reset instead of inheriting", async () => {
    const fixture = await createInspectionFixture();
    await fixture.writeJson("package.json", {
      name: "root",
      private: true,
      workspaces: ["packages/*"],
    });
    await fixture.writeJson("packages/app/package.json", { name: "app" });
    await fixture.write(
      ".prettierrc.json",
      JSON.stringify({ singleQuote: true }),
    );
    await fixture.write(
      "packages/app/.prettierrc.json",
      JSON.stringify({ semi: false }),
    );

    const preview = await previewPrettierSettingsImport(fixture.root);

    const nested = preview.overrides.find((override) =>
      override.files.includes("packages/app/**"),
    );
    expect(nested?.settings).toMatchObject({
      semi: false,
      singleQuote: DEFAULT_FORMATTING_SETTINGS.singleQuote,
    });
  });

  it("materializes a nested empty config as a reset", async () => {
    const fixture = await createInspectionFixture();
    await fixture.writeJson("package.json", {
      name: "root",
      private: true,
      workspaces: ["packages/*"],
    });
    await fixture.writeJson("packages/app/package.json", { name: "app" });
    await fixture.write(
      ".prettierrc.json",
      JSON.stringify({ singleQuote: true }),
    );
    await fixture.write("packages/app/.prettierrc.json", "{}");

    const preview = await previewPrettierSettingsImport(fixture.root);

    expect(
      preview.overrides.find((override) =>
        override.files.includes("packages/app/**"),
      )?.settings.singleQuote,
    ).toBe(false);
  });

  it("copies a nested config directory without a package manifest", async () => {
    const fixture = await createInspectionFixture();
    await fixture.writeJson("package.json", { name: "app" });
    await fixture.write(
      ".prettierrc.json",
      JSON.stringify({ singleQuote: true }),
    );
    await fixture.write(
      "src/.prettierrc.json",
      JSON.stringify({ semi: false }),
    );

    const preview = await previewPrettierSettingsImport(fixture.root);

    expect(
      preview.overrides.find((override) => override.files.includes("src/**")),
    ).toMatchObject({ settings: { semi: false, singleQuote: false } });
  });

  it("fills omitted settings from applicable root .editorconfig values", async () => {
    const fixture = await createInspectionFixture();
    await fixture.writeJson("package.json", { name: "app" });
    await fixture.write(
      ".editorconfig",
      "root = true\n\n[*]\nindent_style = space\nindent_size = 4\nmax_line_length = 110\nend_of_line = lf\n",
    );
    await fixture.write(
      ".prettierrc.json",
      JSON.stringify({ printWidth: 100 }),
    );

    const preview = await previewPrettierSettingsImport(fixture.root);

    expect(preview.settings).toEqual({
      printWidth: 100,
      tabWidth: 4,
      useTabs: false,
      endOfLine: "lf",
    });
  });

  it("copies path-scoped EditorConfig values as managed overrides", async () => {
    const fixture = await createInspectionFixture();
    await fixture.writeJson("package.json", { name: "app" });
    await fixture.write(".prettierrc.json", "{}");
    await fixture.write(
      ".editorconfig",
      "root = true\n\n[*.ts]\nindent_size = 4\n",
    );

    const preview = await previewPrettierSettingsImport(fixture.root);

    expect(preview.overrides).toContainEqual({
      files: ["**/*.ts"],
      excludeFiles: [],
      settings: { tabWidth: 4 },
    });
  });

  it("keeps configuration-file values above .editorconfig values", async () => {
    const fixture = await createInspectionFixture();
    await fixture.writeJson("package.json", { name: "app" });
    await fixture.write(
      ".editorconfig",
      "root = true\n\n[*]\nindent_size = 4\n",
    );
    await fixture.write(".prettierrc.json", JSON.stringify({ tabWidth: 2 }));

    const preview = await previewPrettierSettingsImport(fixture.root);

    expect(preview.settings).toEqual({ tabWidth: 2 });
  });

  it("applies the nearest .editorconfig file over an ancestor", async () => {
    const fixture = await createInspectionFixture();
    await fixture.writeJson("package.json", {
      name: "root",
      private: true,
      workspaces: ["packages/*"],
    });
    await fixture.writeJson("packages/app/package.json", { name: "app" });
    await fixture.write(
      ".editorconfig",
      "root = true\n\n[*]\nindent_size = 4\n",
    );
    await fixture.write("packages/app/.editorconfig", "[*]\nindent_size = 2\n");
    await fixture.write(
      "packages/app/.prettierrc.json",
      JSON.stringify({ semi: false }),
    );

    const preview = await previewPrettierSettingsImport(fixture.root);

    const nested = preview.overrides.find((override) =>
      override.files.includes("packages/app/**"),
    );
    expect(nested?.settings).toMatchObject({
      semi: false,
      tabWidth: 2,
    });
  });

  it("keeps workspace settings scoped when only a workspace configures Prettier", async () => {
    const fixture = await createInspectionFixture();
    await fixture.writeJson("package.json", {
      name: "root",
      private: true,
      workspaces: ["packages/*"],
    });
    await fixture.writeJson("packages/app/package.json", { name: "app" });
    await fixture.write(
      "packages/app/.prettierrc.json",
      JSON.stringify({ printWidth: 100, singleQuote: true }),
    );

    const preview = await previewPrettierSettingsImport(fixture.root);

    expect(preview.settings).toEqual({});
    const scoped = preview.overrides.filter((override) =>
      override.files.includes("packages/app/**"),
    );
    expect(scoped).toHaveLength(1);
    expect(scoped[0]?.settings).toMatchObject({
      printWidth: 100,
      singleQuote: true,
    });
  });

  it("reports ignore-file limitations for nested projects too", async () => {
    const fixture = await createInspectionFixture();
    await fixture.writeJson("package.json", {
      name: "root",
      private: true,
      workspaces: ["packages/*"],
    });
    await fixture.writeJson("packages/app/package.json", { name: "app" });
    await fixture.write(
      "packages/app/.prettierrc.json",
      JSON.stringify({ printWidth: 100 }),
    );
    await fixture.write("packages/app/.prettierignore", "dist\n");

    const preview = await previewPrettierSettingsImport(fixture.root);

    expect(preview.limitations.join("\n")).toMatch(
      /packages\/app\/\.prettierignore/u,
    );
  });

  it("is deterministic across repeat imports", async () => {
    const fixture = await createInspectionFixture();
    await fixture.writeJson("package.json", { name: "app" });
    await fixture.write(
      ".prettierrc.json",
      JSON.stringify({ printWidth: 100, singleQuote: true }),
    );

    const first = await previewPrettierSettingsImport(fixture.root);
    const second = await previewPrettierSettingsImport(fixture.root);

    expect(second).toEqual(first);
  });
});

async function copiedSettings(root: string, file: string) {
  const preview = await previewPrettierSettingsImport(root);
  expect(preview.limitations).toEqual([]);
  const config = resolveConfig({
    schemaVersion: 1,
    checks: { formatting: { settings: preview.settings } },
    overrides: preview.overrides.map((o) => ({
      files: [...o.files],
      checks: { formatting: { settings: o.settings } },
    })),
  });
  return createFilePolicyResolver(config, {
    files: new Map(),
    isEmpty: true,
    containsAddedLine: () => false,
  })("formatting", file, "target").settings;
}

describe("EditorConfig copy fidelity", () => {
  it.each([
    {
      name: "without a Prettier config",
      config: undefined,
      editor: ".editorconfig",
      file: "value.ts",
    },
    {
      name: "below a Prettier config",
      config: {},
      editor: "src/.editorconfig",
      file: "src/value.ts",
    },
  ])("copies EditorConfig $name", async ({ config, editor, file }) => {
    const f = await createInspectionFixture();
    await f.writeJson("package.json", {
      name: "app",
      devDependencies: { prettier: "^3.0.0" },
    });
    if (config) await f.writeJson(".prettierrc.json", config);
    await f.write(editor, "root = true\n[*]\nindent_size = 4\n");
    await f.write(file, "const x=1");
    expect(
      (await prettier.resolveConfig(join(f.root, file), { editorconfig: true }))
        ?.tabWidth,
    ).toBe(4);
    expect((await copiedSettings(f.root, file)).tabWidth).toBe(4);
  });
  it("preserves later universal sections over earlier scoped sections", async () => {
    const f = await createInspectionFixture();
    await f.writeJson("package.json", { name: "app" });
    await f.writeJson(".prettierrc.json", {});
    await f.write(
      ".editorconfig",
      "root = true\n[*.ts]\nindent_size = 4\n[*]\nindent_size = 2\n",
    );
    expect((await copiedSettings(f.root, "value.ts")).tabWidth).toBe(2);
  });
  it("keeps native options above nested EditorConfig values", async () => {
    const f = await createInspectionFixture();
    await f.writeJson("package.json", { name: "app" });
    await f.writeJson(".prettierrc.json", { tabWidth: 6 });
    await f.write("src/.editorconfig", "[*]\nindent_size = 4\n");
    expect((await copiedSettings(f.root, "src/value.ts")).tabWidth).toBe(6);
  });
  it("uses indent_size for space indentation regardless of property order", async () => {
    const f = await createInspectionFixture();
    await f.writeJson("package.json", { name: "app" });
    await f.writeJson(".prettierrc.json", {});
    await f.write(
      ".editorconfig",
      "[*]\nindent_style = space\nindent_size = 2\ntab_width = 8\n",
    );
    expect((await copiedSettings(f.root, "value.ts")).tabWidth).toBe(2);
  });

  it("keeps dependent indentation properties across repeated scoped sections", async () => {
    const f = await createInspectionFixture();
    await f.writeJson("package.json", { name: "app" });
    await f.writeJson(".prettierrc.json", {});
    await f.write(
      ".editorconfig",
      [
        "root = true",
        "[*.ts]",
        "indent_style = space",
        "indent_size = 2",
        "[*.ts]",
        "tab_width = 8",
        "",
      ].join("\n"),
    );
    expect(
      (await prettier.resolveConfig(join(f.root, "value.ts"), {
        editorconfig: true,
      }))?.tabWidth,
    ).toBe(2);
    expect((await copiedSettings(f.root, "value.ts")).tabWidth).toBe(2);
  });

  it("lets a later universal section replace earlier scoped indentation", async () => {
    const f = await createInspectionFixture();
    await f.writeJson("package.json", { name: "app" });
    await f.writeJson(".prettierrc.json", {});
    await f.write(
      ".editorconfig",
      [
        "root = true",
        "[*.ts]",
        "indent_style = space",
        "indent_size = 2",
        "[*]",
        "indent_style = tab",
        "tab_width = 8",
        "[*.ts]",
        "tab_width = 4",
        "",
      ].join("\n"),
    );
    const native = await prettier.resolveConfig(join(f.root, "value.ts"), {
      editorconfig: true,
    });
    expect(native?.useTabs).toBe(true);
    expect(native?.tabWidth).toBe(8);
    const copied = await copiedSettings(f.root, "value.ts");
    expect(copied.useTabs).toBe(true);
    expect(copied.tabWidth).toBe(8);
  });

  it("inherits dependent indentation across ancestor EditorConfig files", async () => {
    const f = await createInspectionFixture();
    await f.writeJson("package.json", { name: "app" });
    await f.writeJson(".prettierrc.json", {});
    await f.write(
      ".editorconfig",
      "root = true\n[*.ts]\nindent_style = space\nindent_size = 2\n",
    );
    await f.write("src/.editorconfig", "[*.ts]\ntab_width = 8\n");
    const native = await prettier.resolveConfig(join(f.root, "src/value.ts"), {
      editorconfig: true,
    });
    expect(native?.tabWidth).toBe(2);
    expect((await copiedSettings(f.root, "src/value.ts")).tabWidth).toBe(2);
  });

  it("reports dependent indentation that crosses overlapping scoped sections", async () => {
    const f = await createInspectionFixture();
    await f.writeJson("package.json", { name: "app" });
    await f.writeJson(".prettierrc.json", {});
    await f.write(
      ".editorconfig",
      [
        "root = true",
        "[*.ts]",
        "indent_style = space",
        "indent_size = 2",
        "[src/**]",
        "tab_width = 8",
        "",
      ].join("\n"),
    );
    expect(
      (await prettier.resolveConfig(join(f.root, "src/value.ts"), {
        editorconfig: true,
      }))?.tabWidth,
    ).toBe(2);

    const imported = await previewPrettierSettingsImport(f.root);
    expect(imported.limitations).toContainEqual(
      expect.stringContaining("overlapping scoped sections"),
    );
  });

  it("does not report independent disjoint indentation scopes", async () => {
    const f = await createInspectionFixture();
    await f.writeJson("package.json", { name: "app" });
    await f.writeJson(".prettierrc.json", {});
    await f.write(
      ".editorconfig",
      [
        "root = true",
        "[*.ts]",
        "indent_style = space",
        "indent_size = 2",
        "[*.js]",
        "indent_style = space",
        "indent_size = 4",
        "",
      ].join("\n"),
    );

    const imported = await previewPrettierSettingsImport(f.root);

    expect(imported.limitations).toEqual([]);
    expect((await copiedSettings(f.root, "value.ts")).tabWidth).toBe(2);
    expect((await copiedSettings(f.root, "value.js")).tabWidth).toBe(4);
  });
});

it("does not replay universal indentation after a scoped indentation override", async () => {
  const f = await createInspectionFixture();
  await f.writeJson("package.json", { name: "app" });
  await f.writeJson(".prettierrc.json", {});
  await f.write(
    ".editorconfig",
    "[*]\nindent_size=2\n[*.ts]\nindent_size=4\n[*]\nmax_line_length=100\n",
  );
  expect((await copiedSettings(f.root, "value.ts")).tabWidth).toBe(4);
});
