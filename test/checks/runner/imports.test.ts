import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { expect, it } from "vitest";

it("default descriptors and worker infrastructure have no eager engine imports", async () => {
  const seen = new Set<string>();
  const external = new Set<string>();
  async function visit(path: string): Promise<void> {
    if (seen.has(path)) return;
    seen.add(path);
    const text = await readFile(path, "utf8");
    const source = ts.createSourceFile(
      path,
      text,
      ts.ScriptTarget.Latest,
      true,
    );
    for (const statement of source.statements) {
      if (
        !ts.isImportDeclaration(statement) &&
        !ts.isExportDeclaration(statement)
      )
        continue;
      if (
        ts.isImportDeclaration(statement) &&
        statement.importClause?.isTypeOnly
      )
        continue;
      if (ts.isExportDeclaration(statement) && statement.isTypeOnly) continue;
      const specifier = statement.moduleSpecifier;
      if (!specifier || !ts.isStringLiteral(specifier)) continue;
      if (specifier.text.startsWith("."))
        await visit(
          resolve(dirname(path), specifier.text.replace(/\.js$/u, ".ts")),
        );
      else if (!specifier.text.startsWith("node:"))
        external.add(specifier.text);
    }
  }
  await visit(
    fileURLToPath(
      new URL("../../../src/checks/descriptors.ts", import.meta.url),
    ),
  );
  await visit(
    fileURLToPath(
      new URL("../../../src/checks/runner/worker.ts", import.meta.url),
    ),
  );
  const engines = [...external].filter((name) =>
    /(?:eslint|prettier|typescript|ast-grep|secretlint|knip|jscpd|dependency-cruiser)/u.test(
      name,
    ),
  );
  expect(engines).toEqual([]);
});
