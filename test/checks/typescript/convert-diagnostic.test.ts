import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as ts from "typescript";
import { convertTypescriptDiagnostic } from "../../../src/checks/typescript/convert-diagnostic.js";

function locatedDiagnostic(root: string, message: string): ts.Diagnostic {
  return {
    category: ts.DiagnosticCategory.Error,
    code: 5083,
    file: ts.createSourceFile(
      join(root, "src/value.ts"),
      "export {};",
      ts.ScriptTarget.ES2022,
      true,
    ),
    start: 0,
    length: 6,
    messageText: message,
  };
}

describe("convertTypescriptDiagnostic", () => {
  it("keeps located identity independent of prose and temporary snapshot roots", () => {
    const firstRoot = "/private/tmp/zedbee-first";
    const secondRoot = "/private/tmp/zedbee-second";
    const first = convertTypescriptDiagnostic(
      locatedDiagnostic(firstRoot, `Cannot read ${firstRoot}/tsconfig.json`),
      firstRoot,
      "/repository",
    );
    const second = convertTypescriptDiagnostic(
      locatedDiagnostic(
        secondRoot,
        `Updated wording at ${secondRoot}/tsconfig.json`,
      ),
      secondRoot,
      "/repository",
    );

    expect(first?.identity).toBe("typescript/TS5083:src/value.ts:1:1");
    expect(second?.identity).toBe(first?.identity);
    expect(JSON.stringify([first, second])).not.toMatch(
      /zedbee-(?:first|second)/u,
    );
  });

  it("normalizes snapshot roots before hashing a locationless diagnostic", () => {
    const make = (root: string): ts.Diagnostic =>
      ({
        category: ts.DiagnosticCategory.Error,
        code: 18003,
        messageText: `No inputs were found in ${root}/tsconfig.json`,
      }) as ts.Diagnostic;
    const first = convertTypescriptDiagnostic(
      make("/private/tmp/zedbee-first"),
      "/private/tmp/zedbee-first",
      "/repository",
    );
    const second = convertTypescriptDiagnostic(
      make("/private/tmp/zedbee-second"),
      "/private/tmp/zedbee-second",
      "/repository",
    );

    expect(second?.identity).toBe(first?.identity);
  });
});
