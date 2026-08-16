import { access, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, onTestFinished, test } from "vitest";
import { createManagedEslint } from "../../../src/checks/eslint/load-engine.js";
import { createGitRepository } from "../../helpers/git-repository.js";

describe("createManagedEslint", () => {
  test("does not discover or execute project ESLint configuration", async () => {
    const repository = await createGitRepository("zedbee-eslint-boundary-");
    await repository.write(
      "eslint.config.mjs",
      `
        import { writeFileSync } from "node:fs";
        writeFileSync("CONFIG_EXECUTED", "yes");
        export default [{ rules: { "project-only-rule": "error" } }];
      `,
    );
    await repository.write("src/value.ts", "export const value: number = 1;\n");
    await repository.write("src/not-requested.ts", "export const nope = ;\n");

    const engine = createManagedEslint({
      cwd: repository.root,
      mode: "lint",
      managedIgnores: [],
    });
    const results = await engine.lintFiles(["src/value.ts"]);

    expect(results.map((result) => result.filePath)).toEqual([
      join(repository.root, "src/value.ts"),
    ]);
    await expect(
      access(join(repository.root, "CONFIG_EXECUTED")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("never calculates fixes or writes scanned source", async () => {
    const repository = await createGitRepository("zedbee-eslint-no-fix-");
    const source = "if (ready) work();\n";
    await repository.write("src/value.js", source);

    const engine = createManagedEslint({
      cwd: repository.root,
      mode: "lint",
      managedIgnores: [],
    });
    const [result] = await engine.lintFiles(["src/value.js"]);

    expect(result?.output).toBeUndefined();
    await expect(repository.read("src/value.js")).resolves.toBe(source);
  });

  test("treats inspector paths as literal filenames instead of glob patterns", async () => {
    const repository = await createGitRepository("zedbee-eslint-literal-");
    await repository.write("src/unrequested.ts", "export const broken = ;\n");
    await repository.write(
      "src/[literal]-雪.ts",
      "export const literal: number = 1;\n",
    );

    const engine = createManagedEslint({
      cwd: repository.root,
      mode: "lint",
      managedIgnores: [],
    });

    await expect(engine.lintFiles(["src/**/*.ts"])).resolves.toEqual([]);
    const literal = await engine.lintFiles(["src/[literal]-雪.ts"]);
    expect(literal.map((result) => result.filePath)).toEqual([
      join(repository.root, "src/[literal]-雪.ts"),
    ]);
  });

  test.each([
    "",
    "../outside.ts",
    "/absolute.ts",
    "C:relative.ts",
    "C:/relative.ts",
    "src\\value.ts",
    "src/value.json",
    "src/value.cjsx",
    "src/value.mtsx",
  ])("rejects a non-source inspector path before linting: %j", async (path) => {
    const repository = await createGitRepository("zedbee-eslint-path-");
    await repository.write("src/value.ts", "export const value = 1;\n");
    const engine = createManagedEslint({
      cwd: repository.root,
      mode: "lint",
      managedIgnores: [],
    });

    await expect(engine.lintFiles([path])).rejects.toThrow(/inspector.*path/i);
  });

  test("rejects a directory whose name has a source extension", async () => {
    const repository = await createGitRepository("zedbee-eslint-directory-");
    await repository.write(
      "src/folder.ts/nested.ts",
      "export const nested = 1;\n",
    );
    const engine = createManagedEslint({
      cwd: repository.root,
      mode: "lint",
      managedIgnores: [],
    });

    await expect(engine.lintFiles(["src/folder.ts"])).rejects.toThrow(
      /inspector.*path/i,
    );
  });

  test("rejects a source symlink that escapes the repository cwd", async () => {
    const repository = await createGitRepository("zedbee-eslint-symlink-");
    const outside = await mkdtemp(join(tmpdir(), "zedbee-eslint-outside-"));
    onTestFinished(() => rm(outside, { recursive: true, force: true }));
    const outsideSource = join(outside, "outside.ts");
    await writeFile(outsideSource, "export const outside = 1;\n");
    await repository.write("src/inside.ts", "export const inside = 1;\n");
    await symlink(outsideSource, join(repository.root, "src/escape.ts"));
    const engine = createManagedEslint({
      cwd: repository.root,
      mode: "lint",
      managedIgnores: [],
    });

    await expect(engine.lintFiles(["src/escape.ts"])).rejects.toThrow(
      /inspector.*path/i,
    );
  });

  test("rejects invalid paths without touching project config or unrequested source", async () => {
    const repository = await createGitRepository("zedbee-eslint-reject-");
    await repository.write(
      "eslint.config.mjs",
      `
        import { writeFileSync } from "node:fs";
        writeFileSync("CONFIG_EXECUTED", "yes");
        export default [];
      `,
    );
    await repository.write("src/unrequested.ts", "export const nope = ;\n");
    const engine = createManagedEslint({
      cwd: repository.root,
      mode: "lint",
      managedIgnores: [],
    });

    await expect(engine.lintFiles(["../outside.ts"])).rejects.toThrow();
    await expect(
      access(join(repository.root, "CONFIG_EXECUTED")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(repository.read("src/unrequested.ts")).resolves.toBe(
      "export const nope = ;\n",
    );
  });
});
