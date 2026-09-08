import { describe, expect, it } from "vitest";
import { runScan } from "../../src/scan/run-scan.js";
import { createGitRepository } from "../helpers/git-repository.js";

const baseline = [
  'import { useEffect, useRef } from "react";',
  "declare const importOriginal: <T>() => T;",
  'const actual = await importOriginal<typeof import("node:fs")>();',
  "export function View({ value }: { value: number }) {",
  "  const ref = useRef(0);",
  "  useEffect(() => { ref.current = value; }, [value]);",
  "  return null;",
  "}",
  "void actual;",
  "",
].join("\n");

const changed = [
  'import { useRef } from "react";',
  "declare const importOriginal: <T>() => T;",
  'const actual = await importOriginal<typeof import("node:fs")>();',
  "export function makeAdapter() {",
  "  return { inspect: () => (ready ? true : false) };",
  "}",
  "export function View({ value }: { value: number }) {",
  "  const ref = useRef(0);",
  "  ref.current = value;",
  "  return null;",
  "}",
  "export const insecure = (input: string) => eval(input);",
  "void actual;",
  "",
].join("\n");

describe("self-scan regressions", () => {
  it("completes analysis of minimized valid self-scan syntax", async () => {
    const repository = await createGitRepository();
    await repository.write(
      "package.json",
      `${JSON.stringify({
        private: true,
        type: "module",
        dependencies: { react: "19.2.0" },
      })}\n`,
    );
    await repository.write(
      "tsconfig.json",
      `${JSON.stringify({
        compilerOptions: {
          target: "ES2023",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          jsx: "react-jsx",
          strict: true,
        },
        include: ["value.tsx"],
      })}\n`,
    );
    await repository.write(
      ".zedbeerc.jsonc",
      `${JSON.stringify({
        schemaVersion: 1,
        profile: "recommended",
        checks: {
          cyclomaticComplexity: { max: 1, blockWorsening: true },
        },
      })}\n`,
    );
    await repository.write("value.tsx", baseline);
    await repository.commitAll("baseline");
    await repository.write("value.tsx", changed);
    await repository.git(["add", "value.tsx"]);

    const report = await runScan({
      repositoryRoot: repository.root,
      cache: false,
    });

    expect(
      report.checks.filter(({ status }) => status === "incomplete"),
    ).toEqual([]);
    expect(report.summary.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ rule: "cyclomatic-complexity" }),
        expect.objectContaining({ rule: "react-hooks/refs" }),
        expect.objectContaining({ rule: "direct-eval" }),
      ]),
    );
  });
});
