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
