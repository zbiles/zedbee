import type { Linter } from "eslint";
import { describe, expect, it } from "vitest";
import { normalizeObservation } from "../../../src/attribution/fingerprint.js";
import { convertEslintMessage } from "../../../src/checks/eslint/convert-message.js";

describe("convertEslintMessage", () => {
  it("normalizes a fatal parser diagnostic without retaining analyzer payloads or snapshot paths", () => {
    const snapshotRoot = "/private/tmp/zedbee-snapshot-secret/target";
    const message = {
      ruleId: null,
      severity: 2,
      fatal: true,
      message: `Parsing failed in ${snapshotRoot}/src/value.ts`,
      line: 2,
      column: 3,
      endLine: 2,
      endColumn: 4,
      nodeType: null,
      source: "const secret = ;",
      fix: { range: [0, 1], text: "secret" },
      suggestions: [
        { desc: "reveal source", fix: { range: [0, 1], text: "secret" } },
      ],
    } as unknown as Linter.LintMessage;

    const observation = convertEslintMessage(
      "src/value.ts",
      message,
      snapshotRoot,
    );

    expect(observation).toMatchObject({
      check: "lint",
      rule: "eslint/parsing-error",
      severity: "error",
      identity: "eslint/parsing-error:src/value.ts:2:3:2:4",
      location: {
        file: "src/value.ts",
        startLine: 2,
        startColumn: 3,
        endLine: 2,
        endColumn: 4,
      },
    });
    expect(JSON.stringify(observation)).not.toMatch(
      /zedbee-snapshot-secret|const secret|reveal source|suggestions/,
    );
    expect(observation.automaticFix).toEqual({
      available: true,
      command: ["npx", "--no-install", "zedbee", "fix", "lint"],
      scope: "finding",
      writes: "working-tree",
      stagesChanges: false,
    });
  });

  it("uses the rule and range, not mutable message prose, as stable identity", () => {
    const base = {
      ruleId: "no-undef",
      severity: 1,
      line: 4,
      column: 2,
      endLine: 4,
      endColumn: 9,
      nodeType: "Identifier",
    } as Linter.LintMessage;

    const first = convertEslintMessage(
      "src/value.js",
      {
        ...base,
        message: "First wording",
      },
      "/snapshot",
    );
    const second = convertEslintMessage(
      "src/value.js",
      {
        ...base,
        message: "Changed wording",
      },
      "/snapshot",
    );

    expect(first.identity).toBe("no-undef:src/value.js:4:2:4:9");
    expect(second.identity).toBe(first.identity);
    expect(first.severity).toBe("warning");
  });

  it("redacts absolute paths without corrupting an HTTPS documentation URL", () => {
    const observation = convertEslintMessage(
      "src/value.ts",
      {
        ruleId: "fixture",
        severity: 2,
        message:
          "See https://typescript-eslint.io/rules and C:/temp/secret.ts or /opt/build/value.ts",
        line: 1,
        column: 1,
        nodeType: "Identifier",
      } as Linter.LintMessage,
      "/snapshot",
    );

    expect(observation.message).toContain("https://typescript-eslint.io/rules");
    expect(observation.message).not.toMatch(/C:|secret|\/opt|build\/value/);
  });

  it.each([
    {
      ruleId: "@typescript-eslint/unbound-method",
      message:
        "A method that is not declared with `this: void` may cause unintentional scoping of `this` when separated from its object.\nConsider using an arrow function or explicitly `.bind()`ing the method to avoid calling the method with an unintended `this` value. \nIf a function does not access `this`, it can be annotated with `this: void`.",
      expected:
        "A method that is not declared with `this: void` may cause unintentional scoping of `this` when separated from its object. Consider using an arrow function or explicitly `.bind()`ing the method to avoid calling the method with an unintended `this` value. If a function does not access `this`, it can be annotated with `this: void`.",
    },
    {
      ruleId: "react-hooks/refs",
      message:
        "Error: Cannot access refs during render\n\nReact refs are values that are not needed for rendering.\n\n/private/tmp/zedbee-snapshot-secret/src/app.tsx:4:3\n  4 | ref.current = value;",
      expected: "Error: Cannot access refs during render",
    },
  ])(
    "produces a bounded safe summary for multiline $ruleId diagnostics",
    ({ ruleId, message, expected }) => {
      const observation = normalizeObservation(
        convertEslintMessage(
          "src/app.tsx",
          {
            ruleId,
            severity: 2,
            message,
            line: 4,
            column: 3,
            nodeType: "Identifier",
          } as Linter.LintMessage,
          "/private/tmp/zedbee-snapshot-secret",
          ruleId.startsWith("react-") ? "reactCorrectness" : "lint",
        ),
      );

      expect(observation.message).toBe(expected);
      expect(observation.message).not.toMatch(/[\p{Cc}\p{Cf}]/u);
      expect(observation.message).not.toContain("zedbee-snapshot-secret");
      expect(observation.location).toEqual({
        file: "src/app.tsx",
        startLine: 4,
        startColumn: 3,
      });
    },
  );

  it("only marks exact managed lint and React diagnostics with an ESLint fix", () => {
    const message = {
      ruleId: "no-undef",
      severity: 2,
      message: "Undefined name.",
      line: 1,
      column: 1,
      nodeType: "Identifier",
      fix: { range: [0, 1], text: "value" },
    } as unknown as Linter.LintMessage;

    expect(
      convertEslintMessage(
        "src/value.ts",
        message,
        "/snapshot",
        "reactCorrectness",
      ).automaticFix?.command,
    ).toEqual(["npx", "--no-install", "zedbee", "fix", "reactCorrectness"]);
    expect(
      convertEslintMessage(
        "src/value.ts",
        message,
        "/snapshot",
        "reactAccessibility",
      ).automaticFix,
    ).toBeUndefined();
    expect(
      convertEslintMessage(
        "src/value.ts",
        { ...message, fix: undefined },
        "/snapshot",
      ).automaticFix,
    ).toBeUndefined();
  });
});
