import { cp, lstat, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createDefaultDiagnosticProbe } from "../../src/doctor/diagnostics.js";
import { createGitRepository } from "../helpers/git-repository.js";

const repositoryPackageRoot = fileURLToPath(new URL("../../", import.meta.url));

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

  it("runs the project formatter only with explicit trust", async () => {
    const repository = await createGitRepository("zedbee-doctor-project-run-");
    await repository.write(
      "package.json",
      '{"name":"fixture","devDependencies":{"prettier":"^3.0.0"}}',
    );
    await mkdir(join(repository.root, "node_modules"), { recursive: true });
    await cp(
      join(repositoryPackageRoot, "node_modules", "prettier"),
      join(repository.root, "node_modules", "prettier"),
      { recursive: true },
    );
    // The declaration must be part of the staged snapshot the probe resolves.
    await repository.git(["add", "--", "package.json"]);

    const diagnostic = await createDefaultDiagnosticProbe()(
      "project-prettier",
      {
        cwd: repository.root,
        environment: {},
        projectPrettierTrust: true,
      },
    );

    expect(diagnostic.status).toBe("pass");
    expect(diagnostic.message).toMatch(/Ran each project's Prettier/u);
    expect(diagnostic.message).toMatch(/root \(3\.9\.6\)/u);
    expect(diagnostic.message).toMatch(/does not verify a full scan/u);
  });

  it("probes every discovered project with its own configuration", async () => {
    const repository = await createGitRepository("zedbee-doctor-nested-");
    await repository.write(
      "package.json",
      '{"name":"root","private":true,"workspaces":["web"]}',
    );
    await repository.write(
      "web/package.json",
      '{"name":"web","devDependencies":{"prettier":"^3.0.0"}}',
    );
    // Only the nested project configures a missing plugin; probing the
    // repository root instead of web/ would silently pass on defaults.
    await repository.write(
      "web/.prettierrc.json",
      '{"plugins":["missing-web-plugin"]}',
    );
    await mkdir(join(repository.root, "node_modules"), { recursive: true });
    await cp(
      join(repositoryPackageRoot, "node_modules", "prettier"),
      join(repository.root, "node_modules", "prettier"),
      { recursive: true },
    );
    await repository.git(["add", "--all"]);

    const diagnostic = await createDefaultDiagnosticProbe()(
      "project-prettier",
      {
        cwd: repository.root,
        environment: {},
        projectPrettierTrust: true,
      },
    );

    expect(diagnostic.status).toBe("fail");
    expect(diagnostic.message).toMatch(/every discovered project/u);
  });

  it("passes a nested project whose configuration formats the probe differently", async () => {
    const repository = await createGitRepository("zedbee-doctor-nested-ok-");
    await repository.write(
      "package.json",
      '{"name":"root","private":true,"workspaces":["web"]}',
    );
    await repository.write(
      "web/package.json",
      '{"name":"web","devDependencies":{"prettier":"^3.0.0"}}',
    );
    await repository.write("web/.prettierrc.json", '{"semi":false}');
    await mkdir(join(repository.root, "node_modules"), { recursive: true });
    await cp(
      join(repositoryPackageRoot, "node_modules", "prettier"),
      join(repository.root, "node_modules", "prettier"),
      { recursive: true },
    );
    await repository.git(["add", "--all"]);

    const diagnostic = await createDefaultDiagnosticProbe()(
      "project-prettier",
      {
        cwd: repository.root,
        environment: {},
        projectPrettierTrust: true,
      },
    );

    expect(diagnostic.status).toBe("pass");
    expect(diagnostic.message).toMatch(/web \(3\.9\.6\)/u);
  });
});