import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { expect, it } from "vitest";

it.each([
  [
    "complexity",
    [
      "eslint-plugin-react",
      "eslint-plugin-react-hooks",
      "eslint-plugin-jsx-a11y",
    ],
  ],
  [
    "lint",
    [
      "eslint-plugin-react",
      "eslint-plugin-react-hooks",
      "eslint-plugin-jsx-a11y",
    ],
  ],
  ["react-correctness", ["eslint-plugin-jsx-a11y"]],
  ["react-accessibility", ["eslint-plugin-react", "eslint-plugin-react-hooks"]],
] as const)(
  "%s configuration loads only its selected rule plugins",
  async (mode, excluded) => {
    const entry = new URL(
      "../../../dist/checks/eslint/managed-config.js",
      import.meta.url,
    ).href;
    const result = await execa(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `
    import { createRequire } from "node:module";
    const require = createRequire(${JSON.stringify(entry)});
    const { managedConfig } = await import(${JSON.stringify(entry)});
    managedConfig({ mode: ${JSON.stringify(mode)}, managedIgnores: [], reactVersion: "19.2.0", ${mode === "complexity" ? "" : "ruleOverrides: {},"} });
    console.log(JSON.stringify(Object.keys(require.cache)));
  `,
      ],
      { cwd: fileURLToPath(new URL("../../..", import.meta.url)) },
    );
    const loaded = JSON.parse(result.stdout) as string[];
    const require = createRequire(import.meta.url);
    for (const name of excluded)
      expect(loaded).not.toContain(require.resolve(name));
  },
);
