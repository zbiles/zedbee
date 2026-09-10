import { describe, expect, it } from "vitest";
import { runScan } from "../../src/scan/run-scan.js";
import { createGitRepository } from "../helpers/git-repository.js";

const baselineSource = [
  "export function App() { return null; }",
  "export function routes(first: boolean, second: boolean) {",
  '  const key = "run";',
  "  return { [key]: async () => { return 0; } };",
  "}",
  "export const count: string = 'one';",
  "",
].join("\n");

const targetSource = [
  "export function App() { return null; }",
  "export function routes(first: boolean, second: boolean) {",
  '  const key = "run";',
  "  return { [key]: async () => {",
  "    if (first) { if (second) return 1; }",
  "    return 0;",
  "  } };",
  "}",
  "export const count: string = 1;",
  "export const evaluate = (input: string) => eval(input);",
  "",
].join("\n");

describe.sequential("nested independent project scans", () => {
  it.each(["index", "base"] as const)(
    "%s runs checks for the changed package without linting an unrelated package config",
    async (mode) => {
      const repository = await createGitRepository("zedbee-nested-scan-");
      await repository.write(
        ".zedbeerc.jsonc",
        JSON.stringify({
          schemaVersion: 1,
          profile: "recommended",
          checks: {
            formatting: "off",
            secrets: "off",
            cyclomaticComplexity: { max: 1, blockWorsening: true },
            readabilityComplexity: { max: 1, blockWorsening: true },
          },
        }),
      );
      await repository.write(
        "web/package.json",
        JSON.stringify({
          name: "web",
          private: true,
          type: "module",
          dependencies: { react: "19.2.0", "react-dom": "19.2.0" },
        }),
      );
      await repository.write(
        "web/tsconfig.json",
        JSON.stringify({
          compilerOptions: {
            target: "ES2022",
            module: "NodeNext",
            moduleResolution: "NodeNext",
            jsx: "preserve",
            strict: true,
          },
          include: ["app.tsx"],
        }),
      );
      await repository.write(
        "extension/package.json",
        JSON.stringify({ name: "extension", private: true, type: "module" }),
      );
      await repository.write(
        "extension/tsconfig.json",
        JSON.stringify({
          compilerOptions: { target: "ES2022", strict: true },
          include: ["src/**/*.ts"],
        }),
      );
      await repository.write(
        "extension/src/index.ts",
        "export const enabled = true;\n",
      );
      await repository.write(
        "extension/vitest.config.ts",
        'import { defineConfig } from "vitest/config";\nexport default defineConfig({});\n',
      );
      await repository.write("web/app.tsx", baselineSource);
      await repository.commitAll("baseline independent packages");
      const baseline = (await repository.git(["rev-parse", "HEAD"])).stdout;
      await repository.write("web/app.tsx", targetSource);
      if (mode === "index") {
        expect((await repository.git(["add", "web/app.tsx"])).exitCode).toBe(0);
      } else {
        await repository.commitAll("change web package");
      }

      const report = await runScan({
        repositoryRoot: repository.root,
        cache: false,
        ...(mode === "base" ? { baseRef: baseline } : {}),
      });

      expect(report).toMatchObject({
        mode,
        outcome: "blocked",
        exitCode: 1,
        changedFileCount: 1,
      });
      expect(
        report.checks.filter(({ status }) => status === "incomplete"),
      ).toEqual([]);
      for (const checkId of [
        "lint",
        "types",
        "reactCorrectness",
        "reactAccessibility",
        "cyclomaticComplexity",
        "readabilityComplexity",
        "structuralSecurity",
      ]) {
        expect(
          report.checks.filter((check) => check.checkId === checkId),
          `${checkId} must analyze the changed nested package`,
        ).toEqual([
          expect.objectContaining({ status: "completed", target: "web" }),
        ]);
      }
      for (const rule of [
        "direct-eval",
        "cyclomatic-complexity",
        "readability-complexity",
      ]) {
        expect(report.summary.findings).toContainEqual(
          expect.objectContaining({
            rule,
            location: expect.objectContaining({ file: "web/app.tsx" }),
            attribution: expect.objectContaining({ staged: true }),
          }),
        );
      }
      expect(report.summary.findings).toContainEqual(
        expect.objectContaining({
          check: "types",
          location: expect.objectContaining({ file: "web/app.tsx" }),
          attribution: expect.objectContaining({ staged: true }),
        }),
      );
      expect(report.checks.some(({ target }) => target === "extension")).toBe(
        false,
      );
    },
  );
});
