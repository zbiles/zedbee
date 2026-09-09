import { Linter } from "eslint";
import tseslint from "typescript-eslint";
import { expect, test } from "vitest";
import { managedConfig } from "../../../src/checks/eslint/managed-config.js";
import type { EslintRuleConfiguration } from "../../../src/config/settings-definition.js";

// Catch changed directive recognition, original ranges/text, options, suggestions,
// or accidental removal of comments from unrelated rules and source parsing.
test("managed lint preserves pinned directive diagnostics and suggestion edits", () => {
  const options: EslintRuleConfiguration[] = [
    "error",
    ["warn", { "ts-check": true, "ts-nocheck": true, "ts-ignore": false }],
    [
      "error",
      {
        "ts-expect-error": true,
        "ts-ignore": "allow-with-description",
        minimumDescriptionLength: 5,
      },
    ],
    [
      "error",
      {
        "ts-expect-error": { descriptionFormat: "^: TS[0-9]+ .+" },
        minimumDescriptionLength: 3,
      },
    ],
  ];
  const prefixes = [
    "",
    " ",
    "\t",
    "\v\f\u00a0\ufeff",
    "** ",
    "// ",
    " * * ",
    "x ",
  ];
  const directives = [
    "",
    "@ts-ignore",
    "@ts-ignore-more",
    "@ts-expect-error",
    "@ts-check",
    "@ts-nocheck",
    "@TS-ignore",
    "@ts-unknown",
  ];
  const breaks = ["\n", "\r", "\r\n", "\u2028", "\u2029"];
  const blocks = prefixes.flatMap((prefix) =>
    directives.map((directive) => `/*${prefix}${directive}: TS123 reason */`),
  );
  const multiline = breaks.flatMap((linebreak) => [
    `/* @ts-ignore${linebreak} plain */`,
    `/* plain${linebreak} * @ts-ignore: explanation */`,
    `/* plain${linebreak}${" ".repeat(128)}*/`,
  ]);
  const source = [
    ...blocks,
    ...multiline,
    "// @ts-ignore",
    "/// @ts-check",
    "// @ts-nocheck",
    "// ordinary comment",
    "const unused = 1;",
    "// @ts-nocheck",
  ].join("\n");
  for (const option of options) {
    const config = managedConfig({
      mode: "lint",
      managedIgnores: [],
      typeInformation: "basic",
      ruleOverrides: {
        "@typescript-eslint/ban-ts-comment": option,
        "spaced-comment": ["error", "always"],
      },
    });
    const stock = config.map((entry) =>
      entry.plugins?.["@typescript-eslint"] === undefined
        ? entry
        : {
            ...entry,
            plugins: {
              ...entry.plugins,
              "@typescript-eslint": tseslint.plugin,
            },
          },
    );
    const actual = new Linter().verify(source, [...config], {
      filename: "fixture.ts",
    });
    const expected = new Linter().verify(source, stock, {
      filename: "fixture.ts",
    });
    expect(actual).toEqual(expected);
    expect(
      actual.some(
        (message) => message.ruleId === "@typescript-eslint/no-unused-vars",
      ),
    ).toBe(true);
    expect(actual.some((message) => message.ruleId === "spaced-comment")).toBe(
      true,
    );
    expect(
      actual.some(
        (message) => message.ruleId === "@typescript-eslint/ban-ts-comment",
      ),
    ).toBe(true);
    if (option === "error") {
      expect(
        actual.some((message) =>
          message.suggestions?.some((suggestion) =>
            suggestion.fix.text.includes("@ts-expect-error"),
          ),
        ),
      ).toBe(true);
    }
  }
});
