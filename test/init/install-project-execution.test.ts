import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, relative } from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createGitRepository } from "../helpers/git-repository.js";
import {
  installProjectDependency,
  projectInstallTargets,
} from "../../src/init/install-project.js";

const execution = vi.hoisted(() => ({
  yarnVersion: "1.22.22",
  command: "",
  calls: [] as Array<{
    command: string;
    args: readonly string[];
    options: { cwd: string; env: Record<string, string> };
  }>,
}));

// Keep Git and repository discovery real; replace only the external install.
vi.mock("execa", async (importOriginal) => {
  const original = await importOriginal<typeof import("execa")>();
  return {
    ...original,
    execa: async (
      command: string,
      args: readonly string[],
      options: {
        cwd: string;
        env: Record<string, string>;
      },
    ) => {
      if (command !== execution.command)
        return original.execa(command, args, options);
      execution.calls.push({ command, args, options });
      if (args[0] === "--version")
        return { stdout: execution.yarnVersion, stderr: "", exitCode: 0 };
      const manifestPath = join(options.cwd, "package.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      await writeFile(
        manifestPath,
        JSON.stringify({ ...manifest, devDependencies: { zedbee: "0.1.0" } }),
      );
      // Modern Yarn's default PnP linker does not create the installation that
      // Swarm's real hook resolver requires when project rc is disabled.
      if (
        Number(execution.yarnVersion.split(".")[0]) >= 3 &&
        options.env.YARN_NODE_LINKER !== "node-modules"
      )
        return { stdout: "", stderr: "", exitCode: 0 };
      const packageRoot = join(options.cwd, "node_modules", "zedbee");
      await mkdir(packageRoot, { recursive: true });
      await writeFile(
        join(packageRoot, "package.json"),
        JSON.stringify({ name: "zedbee", bin: "cli.js" }),
      );
      await writeFile(join(packageRoot, "cli.js"), "// Never executed.\n");
      return { stdout: "", stderr: "", exitCode: 0 };
    },
  };
});

async function trustedYarn(repositoryRoot: string) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "zedbee-installed-yarn-")),
  );
  onTestFinished(async () => {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });
  const command = join(
    root,
    process.platform === "win32" ? "yarn.exe" : "yarn",
  );
  await writeFile(
    command,
    "// External installed manager; execution replaced below.\n",
  );
  await chmod(command, 0o755);
  const hostile = join(repositoryRoot, "tools");
  await mkdir(hostile);
  await writeFile(
    join(hostile, "yarn"),
    `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(join(repositoryRoot, "MANAGER_EXECUTED"))}, "unsafe");\n`,
  );
  await chmod(join(hostile, "yarn"), 0o755);
  execution.command = command;
  vi.stubEnv(
    "PATH",
    `${hostile}${delimiter}${root}${delimiter}${process.env.PATH ?? ""}`,
  );
  return { command, hostile };
}

describe("project installer subprocess boundary", () => {
  it.each([
    ["1.22.22", "yarn@4.0.0", "--ignore-scripts"],
    ["4.9.2", "yarn@1.22.22", "--mode=skip-build"],
  ])(
    "uses installed Yarn %s despite the repository declaration",
    async (version, packageManager, suppression) => {
      execution.calls = [];
      execution.yarnVersion = version;
      const repo = await createGitRepository();
      const installed = await trustedYarn(repo.root);
      await repo.write(
        "package.json",
        JSON.stringify({ name: "fixture", packageManager }),
      );
      const [target] = await projectInstallTargets(repo.root, ["."]);
      await installProjectDependency(
        repo.root,
        { ...target!, args: ["run", "untrusted"] },
        new AbortController().signal,
      );
      const [probe, install] = execution.calls;
      expect(probe?.command).toBe(installed.command);
      expect(install?.command).toBe(installed.command);
      expect(install?.options.env.PATH?.split(delimiter)).not.toContain(
        installed.hostile,
      );
      await expect(
        readFile(join(repo.root, "MANAGER_EXECUTED")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(probe?.args).toEqual(["--version"]);
      expect(relative(repo.root, probe!.options.cwd).startsWith("..")).toBe(
        true,
      );
      expect(install?.args).toContain(suppression);
      expect(install?.args).not.toContain("untrusted");
      expect(install?.options.env).toEqual(
        expect.objectContaining({
          COREPACK_ENABLE_PROJECT_SPEC: "0",
          YARN_IGNORE_PATH: "1",
          YARN_ENABLE_SCRIPTS: "false",
        }),
      );
      expect(install?.options.env.YARN_RC_FILENAME).toMatch(
        /^\.zedbee-[a-f0-9-]+\.yarnrc\.yml$/u,
      );
      if (version.startsWith("1."))
        expect(install?.args).toContain("--no-default-rc");
      else expect(install?.args).not.toContain("--ignore-scripts");
    },
  );

  it("refuses to install when Yarn cannot be identified", async () => {
    execution.calls = [];
    execution.yarnVersion = "not a Yarn version";
    const repo = await createGitRepository();
    await trustedYarn(repo.root);
    await repo.write(
      "package.json",
      '{"name":"fixture","packageManager":"yarn@4.0.0"}',
    );
    const [target] = await projectInstallTargets(repo.root, ["."]);
    await expect(
      installProjectDependency(
        repo.root,
        target!,
        new AbortController().signal,
      ),
    ).rejects.toThrow("Could not identify a supported Yarn version");
    expect(execution.calls).toHaveLength(1);
  });

  it("refuses Yarn 2 because its add command cannot skip workspace builds", async () => {
    execution.calls = [];
    execution.yarnVersion = "2.4.3";
    const repo = await createGitRepository();
    await trustedYarn(repo.root);
    await repo.write(
      "package.json",
      '{"name":"fixture","packageManager":"yarn@2.4.3"}',
    );
    const [target] = await projectInstallTargets(repo.root, ["."]);
    await expect(
      installProjectDependency(
        repo.root,
        target!,
        new AbortController().signal,
      ),
    ).rejects.toThrow("Yarn 2");
    expect(execution.calls).toHaveLength(1);
  });
});
