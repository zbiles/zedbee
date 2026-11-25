import { access } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDefaultDiagnosticProbe } from "../../src/doctor/diagnostics.js";
import { createGitRepository } from "../helpers/git-repository.js";

describe("doctor project ESLint", () => {
  it("reports managed defaults as static JSX checks", async () => {
    const repo = await createGitRepository("zedbee-doctor-eslint-default-");
    await repo.write("package.json", '{"name":"fixture"}');
    const result = await createDefaultDiagnosticProbe()("project-eslint", {
      cwd: repo.root,
      environment: {},
    });
    expect(result.status).toBe("pass");
    expect(result.message).toMatch(
      /built-in ESLint.*Static JSX accessibility checks/u,
    );
  });
  it("reports configuration, dependencies, and separate trust without executing project code", async () => {
    const repo = await createGitRepository("zedbee-doctor-eslint-project-");
    await repo.write(
      "package.json",
      '{"name":"fixture","devDependencies":{"eslint":"9.39.5"}}',
    );
    await repo.write(
      ".zedbeerc.jsonc",
      '{"schemaVersion":1,"checks":{"lint":{"engine":"project"}}}',
    );
    await repo.write(
      "eslint.config.mjs",
      "import { writeFileSync } from 'node:fs'; writeFileSync(new URL('./MARKER', import.meta.url), 'unsafe'); throw new Error('MUST_NOT_EXECUTE');",
    );
    const result = await createDefaultDiagnosticProbe()("project-eslint", {
      cwd: repo.root,
      environment: {},
      projectEslintTrust: true,
    });
    expect(result.status).toBe("fail");
    expect(result.message).toMatch(/eslint.config.mjs/u);
    expect(result.message).toMatch(/9.39.5/u);
    expect(result.message).toMatch(/messages.*not granted/u);
    expect(result.message).toMatch(/not executed/u);
    await expect(access(join(repo.root, "MARKER"))).rejects.toThrow();
  });
});

it.each(["parent", "child", "unsupported"] as const)(
  "selects the %s flat configuration consistently across probes and execution",
  async (kind) => {
    const { findProjectEslintConfig } =
      await import("../../src/checks/eslint/project/config-file.js");
    const repo = await createGitRepository();
    await repo.write("app/.eslintrc.json", "{}");
    if (kind !== "unsupported")
      await repo.write("eslint.config.js", "export default []");
    if (kind === "child")
      await repo.write("app/eslint.config.mjs", "export default []");
    for (const mode of ["doctor", "mirror"] as const) {
      const actual = await findProjectEslintConfig(repo.root, "app", mode);
      expect(actual.supported).toBe(kind !== "unsupported");
      if (actual.supported)
        expect(actual.path).toBe(
          join(
            repo.root,
            kind === "child" ? "app/eslint.config.mjs" : "eslint.config.js",
          ),
        );
    }
  },
);
