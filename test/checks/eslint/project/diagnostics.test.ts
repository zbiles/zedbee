import { expect, it } from "vitest";
import { convertProjectEslintDiagnostic } from "../../../../src/checks/eslint/project/diagnostics.js";
const diagnostic = {
  file: "src/app.tsx",
  ruleId: "private/valid-rule",
  severity: 1 as const,
  message: "Private source: secret",
  line: 3,
  column: 2,
};
it("keeps unknown rule identity, warning and location while redacting prose", () => {
  const result = convertProjectEslintDiagnostic(diagnostic, false);
  expect(result).toMatchObject({
    check: "lint",
    rule: "private/valid-rule",
    severity: "warning",
    location: { file: "src/app.tsx", startLine: 3, startColumn: 2 },
    message: "Project ESLint reported a diagnostic.",
  });
  expect(JSON.stringify(result)).not.toContain("secret");
  expect(result).not.toHaveProperty("automaticFix");
});
it("bounds and sanitizes explicitly permitted local messages", () => {
  const result = convertProjectEslintDiagnostic(
    { ...diagnostic, message: "hello\u001b[31m\n" + "x".repeat(10000) },
    true,
  );
  expect(result.message).not.toMatch(/[\u0000-\u001f]/);
  expect(result.message.length).toBeLessThanOrEqual(4096);
});
it("rejects escaping result paths", () => {
  expect(() =>
    convertProjectEslintDiagnostic(
      { ...diagnostic, file: "../elsewhere" },
      false,
    ),
  ).toThrow();
});
