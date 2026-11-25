import { lstat, mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { inspectWorkspaceInstallations } from "../../src/doctor/workspace-installation.js";
import { createDefaultDiagnosticProbe } from "../../src/doctor/diagnostics.js";
import { executeDoctorCommand } from "../../src/commands/doctor.js";
import { createGitRepository } from "../helpers/git-repository.js";

async function diagnose(root: string) {
  return createDefaultDiagnosticProbe()("workspace-inspection", {
    cwd: root,
    environment: {},
  });
}

describe("doctor workspace installation readiness", () => {
  it("treats an absent manifest behind a same-checkout source link as unverified", async () => {
    const repo = await createGitRepository();
    await repo.write("source/.keep", "");
    await mkdir(join(repo.root, "node_modules/@types"), {
      recursive: true,
    });
    await symlink(
      join(repo.root, "source"),
      join(repo.root, "node_modules/@types/node"),
      "dir",
    );
    const result = await inspectWorkspaceInstallations(repo.root, [
      {
        relativeRoot: ".",
        dependencyDeclarations: [
          {
            name: "@types/node",
            specifier: "*",
            section: "devDependencies",
          },
        ],
      },
    ]);
    expect(result.status).toBe("warning");
    expect(result.summary).toContain("could not verify");
    expect(result.summary).not.toContain("Missing");
  });

  it("escapes unsafe Unicode workspace labels before display", async () => {
    const repo = await createGitRepository();
    const label = "pkg\u2028\u0085\u2066";
    await mkdir(join(repo.root, label), { recursive: true });
    const result = await inspectWorkspaceInstallations(repo.root, [
      {
        relativeRoot: label,
        dependencyDeclarations: [
          {
            name: "@types/node",
            specifier: "*",
            section: "devDependencies",
          },
        ],
      },
    ]);
    expect(result.summary).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
    expect(result.summary).toContain("pkg");
  });
  // Regresses a directory-presence-only installation check: e2e's
  // node_modules exists while its explicitly declared type packages do not.
  it("reports missing declared typings in their independent project", async () => {
    const repo = await createGitRepository();
    await repo.write("package.json", '{"name":"root"}');
    await repo.write(
      "e2e/package.json",
      JSON.stringify({
        name: "e2e",
        devDependencies: { "@types/node": "*", "@types/chrome": "*" },
      }),
    );
    await repo.write(
      "web/package.json",
      '{"name":"web","devDependencies":{"@types/node":"*"}}',
    );
    await repo.write("web/node_modules/@types/node/package.json", "{}");
    await mkdir(join(repo.root, "e2e/node_modules"), { recursive: true });
    await repo.commitAll("fixture");

    const result = await diagnose(repo.root);
    expect(result.status).toBe("warning");
    expect(result.message).toContain("e2e: @types/chrome, @types/node");
    expect(result.message).not.toContain("web:");
    expect(result.message).toContain("HEAD/index");
    expect(result.message).toContain("not run");
    expect(result.remediation).toContain("zedbee scan");
    expect(JSON.stringify(result)).not.toContain(repo.root);
  });

  it("accepts ancestor-hoisted packages without requiring workspace node_modules", async () => {
    const repo = await createGitRepository();
    await repo.write(
      "package.json",
      '{"private":true,"workspaces":["packages/*"]}',
    );
    await repo.write(
      "packages/web/package.json",
      '{"name":"web","devDependencies":{"@types/node":"*"}}',
    );
    await repo.write("node_modules/@types/node/package.json", "{}");
    await repo.commitAll("fixture");

    const result = await diagnose(join(repo.root, "packages/web"));
    expect(result.status).toBe("pass");
    expect(result.message).toContain("HEAD/index");
    expect(result.message).toContain("not run");
    expect(result.message).toContain("data only");
  });

  it("uses the linked checkout's scoped installations rather than the main checkout", async () => {
    const repo = await createGitRepository();
    await repo.write("package.json", '{"name":"root"}');
    await repo.write(
      "extension/package.json",
      '{"name":"extension","devDependencies":{"@types/chrome":"*"}}',
    );
    await repo.write(".gitignore", "node_modules/\n");
    await repo.commitAll("fixture");
    await repo.write(
      "extension/node_modules/@types/chrome/package.json",
      "{}",
    );
    const linked = join(
      repo.root,
      "../",
      `${repo.root.split("/").at(-1)}-linked`,
    );
    expect(
      (await repo.git(["worktree", "add", "--detach", linked])).exitCode,
    ).toBe(0);
    onTestFinished(async () => {
      await repo.git(["worktree", "remove", "--force", linked]);
    });

    expect((await diagnose(linked)).status).toBe("warning");
    await mkdir(join(linked, "extension/node_modules"), {
      recursive: true,
    });
    await symlink(
      join(repo.root, "extension/node_modules/@types"),
      join(linked, "extension/node_modules/@types"),
      "dir",
    );
    const outside = await diagnose(linked);
    expect(outside.status).toBe("warning");
    expect(outside.message).toContain("could not verify");
    expect(outside.message).not.toContain("missing:");
  });

  it("does not execute project configuration or require optional peers", async () => {
    const repo = await createGitRepository();
    await repo.write(
      "package.json",
      JSON.stringify({
        name: "root",
        peerDependencies: { "@types/optional-peer": "*" },
        optionalDependencies: { "@types/optional": "*" },
        devDependencies: { "@types/node": "*" },
      }),
    );
    await repo.write("node_modules/@types/node/package.json", "{}");
    await repo.write("tsconfig.json", '{"extends":"./tsconfig.js"}');
    await repo.write(
      "tsconfig.js",
      "require('node:fs').writeFileSync('EXECUTED', 'yes'); module.exports = {};\n",
    );
    await repo.commitAll("fixture");

    expect((await diagnose(repo.root)).status).toBe("pass");
    await expect(lstat(join(repo.root, "EXECUTED"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("checks selected staged declarations instead of unstaged manifest edits", async () => {
    const repo = await createGitRepository();
    await repo.write(
      "package.json",
      '{"devDependencies":{"@types/node":"*"}}',
    );
    await repo.commitAll("fixture");
    await repo.write("package.json", "{}");
    expect((await diagnose(repo.root)).message).toContain("@types/node");
  });

  it("does not claim absent unrelated development tools are scan prerequisites", async () => {
    const repo = await createGitRepository();
    await repo.write(
      "package.json",
      '{"devDependencies":{"uninstalled-tool":"*"}}',
    );
    await repo.commitAll("fixture");
    expect((await diagnose(repo.root)).status).toBe("pass");
  });

  it("treats a dangling package link as unverified rather than absent", async () => {
    const repo = await createGitRepository();
    await repo.write(
      "package.json",
      '{"devDependencies":{"@types/node":"*"}}',
    );
    await mkdir(join(repo.root, "node_modules/@types"), {
      recursive: true,
    });
    await symlink(
      join(repo.root, "missing"),
      join(repo.root, "node_modules/@types/node"),
      "dir",
    );
    await repo.commitAll("fixture");
    const result = await diagnose(repo.root);
    expect(result.status).toBe("warning");
    expect(result.message).toContain("could not verify");
    expect(result.message).not.toContain("Missing declared");
  });

  it("does not call an absent leaf behind an unsupported nested link a missing installation", async () => {
    const repo = await createGitRepository();
    const outside = await createGitRepository();
    await repo.write("package.json", '{"name":"root"}');
    await repo.write(
      "extension/package.json",
      '{"devDependencies":{"@types/node":"*"}}',
    );
    await mkdir(join(repo.root, "extension/node_modules"), {
      recursive: true,
    });
    await mkdir(join(outside.root, "typings/node"), { recursive: true });
    await symlink(
      join(outside.root, "typings"),
      join(repo.root, "extension/node_modules/@types"),
      "dir",
    );
    await repo.write(".gitignore", "node_modules/\n");
    await repo.commitAll("fixture");
    const result = await diagnose(repo.root);
    expect(result.status).toBe("warning");
    expect(result.message).toContain("could not verify");
    expect(result.message).not.toContain("Missing declared");
  });

  it("accepts a shared canonical root node_modules installation", async () => {
    const repo = await createGitRepository();
    const shared = await createGitRepository();
    await repo.write(
      "package.json",
      '{"devDependencies":{"@types/node":"*"}}',
    );
    await shared.write("node_modules/@types/node/package.json", "{}");
    await symlink(
      join(shared.root, "node_modules"),
      join(repo.root, "node_modules"),
      "dir",
    );
    await repo.write(".gitignore", "node_modules\n");
    await repo.commitAll("fixture");
    expect((await diagnose(repo.root)).status).toBe("pass");
  });

  it("does not accept an oversized installed manifest as verified readiness", async () => {
    const repo = await createGitRepository();
    await repo.write(
      "package.json",
      '{"devDependencies":{"@types/node":"*"}}',
    );
    await repo.write(
      "node_modules/@types/node/package.json",
      " ".repeat(1024 * 1024 + 1),
    );
    await repo.commitAll("fixture");
    const result = await diagnose(repo.root);
    expect(result.status).toBe("warning");
    expect(result.message).toContain("could not verify");
  });

  it("reports bounded inspection as partial rather than falsely ready", async () => {
    const repo = await createGitRepository();
    const result = await inspectWorkspaceInstallations(
      repo.root,
      Array.from({ length: 513 }, () => ({
        relativeRoot: ".",
        dependencyDeclarations: [],
      })),
    );
    expect(result.status).toBe("warning");
    expect(result.summary).toContain("bounded");
    expect(result.summary).toContain("not completed");
  });

  it("stops package metadata probes at a finite budget and warns about partial readiness", async () => {
    const repo = await createGitRepository();
    const result = await inspectWorkspaceInstallations(repo.root, [
      {
        relativeRoot: ".",
        dependencyDeclarations: Array.from({ length: 4097 }, (_, i) => ({
          name: `@types/package-${i}`,
          specifier: "*",
          section: "devDependencies" as const,
        })),
      },
    ]);
    expect(result.status).toBe("warning");
    expect(result.summary).toContain("bounded");
    expect(result.summary).toContain("not completed");
  });

  it("bounds reported installation gaps without hiding the warning", async () => {
    const repo = await createGitRepository();
    const result = await inspectWorkspaceInstallations(repo.root, [
      {
        relativeRoot: ".",
        dependencyDeclarations: Array.from({ length: 12 }, (_, i) => ({
          name: `@types/missing-${String(i).padStart(2, "0")}`,
          specifier: "*",
          section: "devDependencies" as const,
        })),
      },
    ]);
    expect(result.status).toBe("warning");
    expect(result.summary).toContain("@types/missing-00");
    expect(result.summary).not.toContain("@types/missing-11");
    expect(result.summary).toContain("4 additional installation gaps");
  });

  it("keeps the installation warning actionable in text and JSON", async () => {
    const repo = await createGitRepository();
    await repo.write(
      "package.json",
      '{"name":"root","devDependencies":{"@types/node":"*"}}',
    );
    await repo.commitAll("fixture");
    const diagnostic = await diagnose(repo.root);
    const React = await import("react");
    const { render } = await import("ink-testing-library");
    const { DoctorDashboard } =
      await import("../../src/ui/doctor-dashboard.js");
    const dashboard = render(
      React.createElement(DoctorDashboard, {
        width: 100,
        color: false,
        diagnostics: [diagnostic],
      }),
    );
    expect(dashboard.lastFrame()).toContain("@types/node");
    expect(dashboard.lastFrame()).toContain("zedbee scan");
    expect(dashboard.lastFrame()).toContain("WARNING");
    dashboard.unmount();
    for (const format of ["text", "json"] as const) {
      const output: string[] = [];
      const result = await executeDoctorCommand(
        {
          cwd: repo.root,
          environment: {},
          format,
          color: false,
        },
        {
          stdoutIsTTY: false,
          width: 80,
          env: {},
          writeStdout: (text) => output.push(text),
          writeStderr: () => undefined,
        },
        { diagnose: async () => [diagnostic] },
      );
      expect(result.exitCode).toBe(0);
      expect(output.join("")).toContain("@types/node");
      expect(output.join("")).toContain("zedbee scan");
    }
  });
});
