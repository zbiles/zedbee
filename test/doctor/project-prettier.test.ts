import { cp, lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, onTestFinished } from "vitest";
import {
  persistProjectPrettierTrust,
  readProjectPrettierTrust,
} from "../../src/checks/prettier/project-trust.js";
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
it("reports unreadable discovery as failed without claiming absence", async () => {
  const repo = await createGitRepository();
  await repo.write("package.json", "{ bad JSON");
  const result = await createDefaultDiagnosticProbe()("project-prettier", {
    cwd: repo.root,
    environment: {},
  });
  expect(result.status).toBe("fail");
  expect(result.message).toMatch(/could not be inspected/u);
});

it.each([false, true])(
  "cannot pass a required project formatter with no declaration or installation (trust=%s)",
  async (projectPrettierTrust) => {
    const repo = await createGitRepository();
    await repo.write("package.json", '{"name":"fixture"}');
    await repo.write(
      ".zedbeerc.jsonc",
      '{"schemaVersion":1,"checks":{"formatting":{"engine":"project"}}}',
    );
    await repo.git(["add", "--all"]);
    const result = await createDefaultDiagnosticProbe()("project-prettier", {
      cwd: repo.root,
      environment: {},
      projectPrettierTrust,
    });
    expect(result.status).toBe("fail");
    expect(result.message).toContain("Required project Prettier");
  },
);

it("recognizes saved scoped readiness without executing config and keeps required scopes separate", async () => {
  const repo = await createGitRepository();
  await repo.write(
    "package.json",
    '{"name":"root","private":true,"workspaces":["web","api"]}',
  );
  for (const name of ["web", "api"]) {
    await repo.write(
      `${name}/package.json`,
      JSON.stringify({ name, devDependencies: { prettier: "^3.0.0" } }),
    );
  }
  await repo.write(
    ".zedbeerc.jsonc",
    JSON.stringify({
      schemaVersion: 1,
      overrides: [
        {
          files: ["web/**", "api/**"],
          checks: { formatting: { engine: "project" } },
        },
      ],
    }),
  );
  await repo.write(
    "web/prettier.config.mjs",
    "import { writeFileSync } from 'node:fs'; writeFileSync(" +
      JSON.stringify(join(repo.root, "PROJECT_PRETTIER_MARKER")) +
      ", 'executed'); export default {};",
  );
  await repo.git(["add", "--all"]);
  await repo.commitAll("fixture");
  await mkdir(join(repo.root, "node_modules"), { recursive: true });
  await cp(
    join(repositoryPackageRoot, "node_modules", "prettier"),
    join(repo.root, "node_modules", "prettier"),
    { recursive: true },
  );
  const probe = createDefaultDiagnosticProbe();
  const context = { cwd: repo.root, environment: {} };
  const initial = await probe("project-prettier", context);
  expect(initial.status).toBe("warning");
  expect(initial.message).toMatch(/api.*web/u);
  await persistProjectPrettierTrust(repo.root, "web");
  const mixed = await probe("project-prettier", context);
  expect(mixed.status).toBe("warning");
  expect(mixed.message).toContain("Missing execution consent for api");
  await persistProjectPrettierTrust(repo.root, "api");
  const ready = await probe("project-prettier", context);
  expect(ready.status).toBe("pass");
  expect(ready.message).toMatch(/execution probe was skipped/u);
  expect(ready.message).toMatch(/web: available 3\.9\.6/u);
  expect(await markerExists(repo.root, "PROJECT_PRETTIER_MARKER")).toBe(false);

  await repo.write(
    ".zedbeerc.jsonc",
    JSON.stringify({
      schemaVersion: 1,
      overrides: [
        { files: ["web/**"], checks: { formatting: { engine: "project" } } },
      ],
    }),
  );
  await repo.git(["add", "--", ".zedbeerc.jsonc"]);
  // A new worktree keeps saved Git-local consent.
  await repo.git(["commit", "-m", "scope"]);
  const linked = await mkdtemp(join(tmpdir(), "zedbee-linked-doctor-"));
  onTestFinished(async () => {
    await repo.git(["worktree", "remove", "--force", linked]);
    await rm(linked, { recursive: true, force: true });
  });
  expect(
    (await repo.git(["worktree", "add", "--detach", linked])).exitCode,
  ).toBe(0);
  await mkdir(join(linked, "node_modules"), { recursive: true });
  await cp(
    join(repositoryPackageRoot, "node_modules", "prettier"),
    join(linked, "node_modules", "prettier"),
    { recursive: true },
  );
  expect(
    (await probe("project-prettier", { ...context, cwd: linked })).status,
  ).toBe("pass");

  const clone = await mkdtemp(join(tmpdir(), "zedbee-clone-doctor-"));
  onTestFinished(() => rm(clone, { recursive: true, force: true }));
  expect(
    (await repo.git(["clone", "--local", repo.root, clone])).exitCode,
  ).toBe(0);
  await mkdir(join(clone, "node_modules"), { recursive: true });
  await cp(
    join(repositoryPackageRoot, "node_modules", "prettier"),
    join(clone, "node_modules", "prettier"),
    { recursive: true },
  );
  expect(
    (await probe("project-prettier", { ...context, cwd: clone })).status,
  ).toBe("warning");
  // Missing installations take precedence even with a grant.
  await rm(join(linked, "node_modules", "prettier"), {
    recursive: true,
    force: true,
  });
  expect(
    (await probe("project-prettier", { ...context, cwd: linked })).status,
  ).toBe("fail");
});

it("does not persist one-time doctor consent", async () => {
  const repo = await createGitRepository();
  await repo.write(
    "package.json",
    '{"name":"fixture","devDependencies":{"prettier":"^3.0.0"}}',
  );
  await repo.write(
    ".zedbeerc.jsonc",
    '{"schemaVersion":1,"checks":{"formatting":{"engine":"project"}}}',
  );
  await repo.git(["add", "--all"]);
  await mkdir(join(repo.root, "node_modules"), { recursive: true });
  await cp(
    join(repositoryPackageRoot, "node_modules", "prettier"),
    join(repo.root, "node_modules", "prettier"),
    { recursive: true },
  );
  expect(
    (
      await createDefaultDiagnosticProbe()("project-prettier", {
        cwd: repo.root,
        environment: {},
        projectPrettierTrust: true,
      })
    ).status,
  ).toBe("pass");
  expect(await readProjectPrettierTrust(repo.root, ".")).toBeUndefined();
});
