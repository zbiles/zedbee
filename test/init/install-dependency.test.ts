import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import {
  installDependency,
  windowsManagerInvocation,
} from "../../src/init/install-dependency.mjs";

async function fixture(manager = "npm") {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "zedbee-manager-trust-")),
  );
  onTestFinished(async () => {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });
  const repository = join(root, "repository");
  const project = join(repository, "packages", "app");
  const trusted = join(root, "trusted");
  await mkdir(project, { recursive: true });
  await mkdir(join(repository, ".git"));
  await mkdir(trusted);
  const executable = join(
    trusted,
    `${manager}${process.platform === "win32" ? ".exe" : ""}`,
  );
  await writeFile(executable, "// External installed manager fixture.\n");
  await chmod(executable, 0o755);
  return { root, repository, project, trusted, executable };
}

describe("installer executable trust", () => {
  it
    .skipIf(process.platform === "win32")
    .each([
      "repository",
      "dependency-bin",
      "directory-link",
      "executable-link",
    ])(
    "does not delegate a %s PATH candidate to an injected executor",
    async (kind) => {
      const f = await fixture();
      const hostile = join(f.repository, "tools");
      const external = join(f.root, "untrusted");
      await mkdir(hostile);
      await mkdir(external);
      await writeFile(join(hostile, "npm"), "// Project executable.\n");
      await chmod(join(hostile, "npm"), 0o755);
      let unsafe = hostile;
      if (kind === "dependency-bin") {
        unsafe = join(f.root, "node_modules", ".bin");
        await mkdir(unsafe, { recursive: true });
        await writeFile(join(unsafe, "npm"), "// Dependency executable.\n");
        await chmod(join(unsafe, "npm"), 0o755);
      } else if (kind === "directory-link") {
        unsafe = join(external, "link");
        await symlink(hostile, unsafe);
      } else if (kind === "executable-link") {
        unsafe = external;
        await symlink(join(hostile, "npm"), join(external, "npm"));
      }
      vi.stubEnv("PATH", ["", ".", "tools", unsafe, f.trusted].join(delimiter));
      const calls: Array<{ command: string; path: string | undefined }> = [];
      await installDependency(
        { manager: "npm", cwd: f.project, packageSpec: "zedbee@0.1.0" },
        async (command, _args, options) => {
          calls.push({ command, path: options.env.PATH });
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      );
      expect(calls).toEqual([
        {
          command: f.executable,
          path:
            kind === "executable-link"
              ? `${external}${delimiter}${f.trusted}`
              : f.trusted,
        },
      ]);
    },
  );

  it("fails closed before execution when PATH has no trusted manager", async () => {
    const f = await fixture();
    vi.stubEnv("PATH", ["", ".", f.repository].join(delimiter));
    let executed = false;
    await expect(
      installDependency(
        { manager: "npm", cwd: f.project, packageSpec: "zedbee@0.1.0" },
        async () => {
          executed = true;
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      ),
    ).rejects.toThrow("No trusted npm executable");
    expect(executed).toBe(false);
  });

  it.skipIf(process.platform === "win32")(
    "preserves an externally installed manager reached through a symlink",
    async () => {
      const f = await fixture();
      const script = join(f.root, "installed", "npm.cjs");
      await mkdir(join(f.root, "installed"));
      await writeFile(script, "// External npm entry.\n");
      await chmod(script, 0o755);
      await rm(f.executable);
      await symlink(script, f.executable);
      vi.stubEnv("PATH", f.trusted);
      vi.stubEnv("Path", f.repository);
      let resolved: string | undefined;
      await installDependency(
        { manager: "npm", cwd: f.project, packageSpec: "zedbee@0.1.0" },
        async (command, _args, options) => {
          resolved = command;
          expect(options.env.PATH).toBe(f.trusted);
          expect(options.env.Path).toBeUndefined();
          expect(options.extendEnv).toBe(false);
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      );
      expect(resolved).toBe(script);
    },
  );

  it("keeps the resolved Yarn identity and safe PATH across probe and install", async () => {
    const f = await fixture("yarn");
    vi.stubEnv("PATH", f.trusted);
    const calls: Array<{ command: string; path: string | undefined }> = [];
    await installDependency(
      { manager: "yarn", cwd: f.project, packageSpec: "zedbee@0.1.0" },
      async (command, _args, options) => {
        calls.push({ command, path: options.env.PATH });
        vi.stubEnv("PATH", f.repository);
        return { exitCode: 0, stdout: "1.22.22", stderr: "" };
      },
    );
    expect(calls).toEqual([
      { command: f.executable, path: f.trusted },
      { command: f.executable, path: f.trusted },
    ]);
  });

  it("refuses a Windows shim whose Node entry resolves into the repository", async () => {
    const f = await fixture();
    const entry = join(f.repository, "npm.js");
    await writeFile(entry, "// Project-controlled shim entry.\n");
    await writeFile(
      join(f.trusted, "npm.cmd"),
      '@ECHO OFF\n"%dp0%\\..\\repository\\npm.js" %*\n',
    );
    // Do not let the .exe fixture hide the deliberately unsafe shim.
    await rm(f.executable);
    await expect(
      windowsManagerInvocation("npm", f.trusted, f.project),
    ).rejects.toThrow("No trusted npm executable");
  });

  it.skipIf(process.platform === "win32")(
    "refuses a Windows shim whose Node entry is a symlink into the repository",
    async () => {
      const f = await fixture();
      await writeFile(join(f.repository, "npm.js"), "// Project entry.\n");
      await symlink(join(f.repository, "npm.js"), join(f.trusted, "npm.js"));
      await writeFile(
        join(f.trusted, "npm.cmd"),
        '@ECHO OFF\n"%dp0%\\npm.js" %*\n',
      );
      await rm(f.executable);
      await expect(
        windowsManagerInvocation("npm", f.trusted, f.project),
      ).rejects.toThrow("No trusted npm executable");
    },
  );
});
