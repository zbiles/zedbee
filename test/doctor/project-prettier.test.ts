import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDefaultDiagnosticProbe } from "../../src/doctor/diagnostics.js";
import { createGitRepository } from "../helpers/git-repository.js";

async function markerExists(root: string, name: string): Promise<boolean> {
  try {
    await lstat(join(root, name));
    return true;
  } catch {
    return false;
  }
}

describe("doctor project Prettier diagnosis", () => {
  it("reports a detected setup without executing project configuration", async () => {
    const repository = await createGitRepository("zedbee-doctor-project-");
    await repository.write(
      "package.json",
      '{"name":"fixture","devDependencies":{"prettier":"^3.0.0"}}',
    );
    await repository.write(
      "prettier.config.mjs",
      "import { writeFileSync } from 'node:fs';\n" +
        "writeFileSync(new URL('./MARKER_DOCTOR', import.meta.url), 'executed');\n" +
        "export default { singleQuote: true };\n",
    );
    const probe = createDefaultDiagnosticProbe();

    const diagnostic = await probe("project-prettier", {
      cwd: repository.root,
      environment: {},
    });

    expect(diagnostic.status).toBe("pass");
    expect(diagnostic.message).toMatch(/Detected project Prettier/u);
    expect(diagnostic.message).toMatch(/not executed/u);
    expect(await markerExists(repository.root, "MARKER_DOCTOR")).toBe(false);
  });

  it("reports the managed default when no project setup exists", async () => {
    const repository = await createGitRepository("zedbee-doctor-project-none-");
    await repository.write("package.json", '{"name":"fixture"}');

    const diagnostic = await createDefaultDiagnosticProbe()(
      "project-prettier",
      { cwd: repository.root, environment: {} },
    );

    expect(diagnostic.status).toBe("pass");
    expect(diagnostic.message).toMatch(/No project Prettier setup/u);
  });
});