import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
  onTestFinished,
} from "vitest";
import {
  createGitRepository,
  type TestGitRepository,
} from "../helpers/git-repository.js";
import {
  installPackedFixture,
  sharedPackedTarball,
} from "../helpers/packed-install.js";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
let packDirectory: string;
let tarballPath: string;

beforeAll(async () => {
  packDirectory = await mkdtemp(join(tmpdir(), "zedbee-premerge-pack-"));
  const shared = sharedPackedTarball();
  if (shared !== null) {
    tarballPath = shared.path;
    return;
  }
  const packed = await execa(
    "npm",
    ["pack", "--json", "--ignore-scripts", "--pack-destination", packDirectory],
    {
      cwd: packageRoot,
      env: { npm_config_cache: join(packDirectory, "npm-cache") },
      reject: false,
      stdin: "ignore",
    },
  );
  expect(packed.exitCode, packed.stderr).toBe(0);
  const metadata = JSON.parse(packed.stdout) as Array<{ filename: string }>;
  tarballPath = join(packDirectory, metadata[0]!.filename);
});

afterAll(async () => {
  await rm(packDirectory, { recursive: true, force: true });
});

async function gitPath(repository: TestGitRepository, name: string) {
  const result = await repository.git(["rev-parse", "--git-path", name]);
  expect(result.exitCode, result.stderr).toBe(0);
  return isAbsolute(result.stdout)
    ? result.stdout
    : join(repository.root, result.stdout);
}

async function customHook(repository: TestGitRepository, name: string) {
  const path = await gitPath(repository, `hooks/${name}`);
  await writeFile(
    path,
    [
      "#!/bin/sh",
      `printf '${name}:' >> "$(git rev-parse --git-path observed-hooks)"`,
      'if test -f "$(git rev-parse --git-path MERGE_HEAD)"; then',
      '  printf "MERGE_HEAD=present\\n" >> "$(git rev-parse --git-path observed-hooks)"',
      "else",
      '  printf "MERGE_HEAD=absent\\n" >> "$(git rev-parse --git-path observed-hooks)"',
      "fi",
      ...(name === "pre-merge-commit"
        ? [
            "env | sed -n '/^GITHEAD_/p' > \"$(git rev-parse --git-path merge-environment)\"",
          ]
        : []),
      "",
    ].join("\n"),
  );
  await chmod(path, 0o755);
}

async function fixture(project = ".") {
  const repository = await createGitRepository("zedbee-premerge-hook-");
  const projectRoot = join(repository.root, project);
  await repository.write(
    join(project, "package.json"),
    '{"name":"premerge-hook-fixture","version":"1.0.0","private":true,"devDependencies":{"zedbee":"*"}}\n',
  );
  await repository.write(".gitignore", "node_modules/\n");
  await repository.write(
    join(project, "tsconfig.json"),
    '{"compilerOptions":{"strict":true,"noEmit":true},"include":["**/*.ts"]}\n',
  );
  await repository.write(
    join(project, "summarize.ts"),
    "export const advisoryLabel = () => 'label';\n",
  );
  await repository.commitAll("base project");
  await installPackedFixture(
    tarballPath,
    packageRoot,
    projectRoot,
    join(packDirectory, "install-cache"),
  );
  await customHook(repository, "pre-commit");
  await customHook(repository, "pre-merge-commit");

  const cli = join(projectRoot, "node_modules/zedbee/dist/cli.js");
  const environment = {
    XDG_CACHE_HOME: await mkdtemp(join(packDirectory, "fixture-cache-")),
  };
  const git = (args: readonly string[], cwd = repository.root) =>
    execa("git", args, {
      cwd,
      env: environment,
      reject: false,
      stdin: "ignore",
    });
  const invoke = (args: readonly string[], cwd = projectRoot) =>
    execa(process.execPath, [cli, ...args], {
      cwd,
      env: environment,
      reject: false,
      stdin: "ignore",
    });
  const initialize = () =>
    invoke([
      "init",
      "--profile",
      "recommended",
      "--checks",
      "types",
      "--hook",
      "raw",
      "--yes",
      "--format",
      "json",
      "--no-color",
      "--no-animations",
    ]);
  const initialized = await initialize();
  expect(initialized.exitCode, initialized.stderr || initialized.stdout).toBe(
    0,
  );
  const commitFixture = async (message: string) => {
    expect((await git(["add", "--all"])).exitCode).toBe(0);
    const committed = await git([
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "--message",
      message,
    ]);
    expect(committed.exitCode, committed.stderr).toBe(0);
  };
  await commitFixture("merge policy");
  expect((await git(["branch", "incoming"])).exitCode).toBe(0);
  onTestFinished(async () => {
    await execa(
      process.execPath,
      [join(packageRoot, "dist/cli.js"), "service", "stop", "--format", "json"],
      {
        cwd: packageRoot,
        env: environment,
        reject: false,
        stdin: "ignore",
      },
    ).catch(() => {});
  });
  return {
    repository,
    project,
    projectRoot,
    environment,
    git,
    invoke,
    initialize,
    commitFixture,
    observedHooks: async () =>
      readFile(await gitPath(repository, "observed-hooks"), "utf8"),
  };
}

describe("installed pre-merge-commit hooks", () => {
  it.each(["incoming", "main"] as const)(
    "allows inherited type debt from %s during an automatic merge",
    async (debtBranch) => {
      const setup = await fixture();
      const { repository, git, commitFixture } = setup;
      expect((await git(["switch", "incoming"])).exitCode).toBe(0);
      await repository.write(
        "incoming.ts",
        debtBranch === "incoming"
          ? 'export const incoming: number = "inherited debt";\n'
          : "export const incoming = true;\n",
      );
      await commitFixture("incoming branch");
      const incoming = (await git(["rev-parse", "HEAD"])).stdout;
      expect((await git(["switch", "main"])).exitCode).toBe(0);
      await repository.write(
        "main.ts",
        debtBranch === "main"
          ? 'export const main: number = "inherited debt";\n'
          : "export const main = true;\n",
      );
      await commitFixture("main branch");
      const head = (await git(["rev-parse", "HEAD"])).stdout;

      const merged = await git(["merge", "--no-edit", "--no-ff", "incoming"]);

      expect(merged.exitCode, merged.stdout + merged.stderr).toBe(0);
      expect(
        (await git(["show", "--format=%P", "--no-patch", "HEAD"])).stdout,
      ).toBe(`${head} ${incoming}`);
      expect(await setup.observedHooks()).toBe(
        "pre-merge-commit:MERGE_HEAD=absent\n",
      );
      const metadata = await readFile(
        await gitPath(repository, "merge-environment"),
        "utf8",
      );
      expect(metadata).toContain(`GITHEAD_${incoming}=`);
    },
  );

  it("blocks a caller/export incompatibility created by an automatic merge", async () => {
    const setup = await fixture();
    const { repository, git, commitFixture } = setup;
    await git(["switch", "incoming"]);
    await repository.write(
      "incoming-caller.ts",
      "import { advisoryLabel } from './summarize';\nexport const label = advisoryLabel();\n",
    );
    await commitFixture("new caller");
    const incoming = (await git(["rev-parse", "HEAD"])).stdout;
    await git(["switch", "main"]);
    await repository.write(
      "summarize.ts",
      "export const advisoryLabelRenamed = () => 'label';\n",
    );
    await commitFixture("renamed export");
    const head = (await git(["rev-parse", "HEAD"])).stdout;

    const merged = await git(["merge", "--no-edit", "--no-ff", "incoming"]);

    expect(merged.exitCode, merged.stdout + merged.stderr).not.toBe(0);
    expect(merged.stdout + merged.stderr).toContain("TS2305");
    expect(merged.stdout + merged.stderr).toContain("incoming-caller.ts");
    expect((await git(["rev-parse", "HEAD"])).stdout).toBe(head);
    expect(
      await readFile(await gitPath(repository, "MERGE_HEAD"), "utf8"),
    ).toBe(`${incoming}\n`);
    expect(await setup.observedHooks()).toBe(
      "pre-merge-commit:MERGE_HEAD=absent\n",
    );
  });

  it("blocks a new conflict-resolution finding through the ordinary pre-commit hook", async () => {
    const setup = await fixture();
    const { repository, git, commitFixture } = setup;
    await repository.write("resolution.ts", "export const resolution = 0;\n");
    await commitFixture("common resolution");
    await git(["branch", "--force", "incoming", "HEAD"]);
    await git(["switch", "incoming"]);
    await repository.write("resolution.ts", "export const resolution = 1;\n");
    await commitFixture("incoming resolution");
    const incoming = (await git(["rev-parse", "HEAD"])).stdout;
    await git(["switch", "main"]);
    await repository.write("resolution.ts", "export const resolution = 2;\n");
    await commitFixture("main resolution");
    const head = (await git(["rev-parse", "HEAD"])).stdout;
    const conflicted = await git(["merge", "--no-edit", "--no-ff", "incoming"]);
    expect(conflicted.exitCode).not.toBe(0);
    await repository.write(
      "resolution.ts",
      'export const resolution: number = "new resolution error";\n',
    );
    await git(["add", "--", "resolution.ts"]);
    // The working-tree repair must not mask the staged merge resolution.
    await repository.write("resolution.ts", "export const resolution = 3;\n");

    const committed = await git(["commit", "--message", "resolved merge"]);

    expect(committed.exitCode, committed.stdout + committed.stderr).not.toBe(0);
    expect(committed.stdout + committed.stderr).toContain("TS2322");
    expect((await git(["rev-parse", "HEAD"])).stdout).toBe(head);
    expect(
      await readFile(await gitPath(repository, "MERGE_HEAD"), "utf8"),
    ).toBe(`${incoming}\n`);
    expect(await setup.observedHooks()).toBe("pre-commit:MERGE_HEAD=present\n");
  });

  it("allows inherited incoming debt when a conflict is resolved with git commit", async () => {
    const setup = await fixture();
    const { repository, git, commitFixture } = setup;
    await repository.write("resolution.ts", "export const resolution = 0;\n");
    await commitFixture("common resolution");
    await git(["branch", "--force", "incoming", "HEAD"]);
    await git(["switch", "incoming"]);
    await repository.write("resolution.ts", "export const resolution = 1;\n");
    await repository.write("debt.ts", 'export const debt: number = "debt";\n');
    await commitFixture("incoming debt and conflict");
    const incoming = (await git(["rev-parse", "HEAD"])).stdout;
    await git(["switch", "main"]);
    await repository.write("resolution.ts", "export const resolution = 2;\n");
    await commitFixture("main conflict");
    const head = (await git(["rev-parse", "HEAD"])).stdout;
    expect(
      (await git(["merge", "--no-edit", "--no-ff", "incoming"])).exitCode,
    ).not.toBe(0);
    await repository.write("resolution.ts", "export const resolution = 3;\n");
    await git(["add", "--", "resolution.ts"]);

    const committed = await git(["commit", "--message", "resolved merge"]);

    expect(committed.exitCode, committed.stdout + committed.stderr).toBe(0);
    expect(
      (await git(["show", "--format=%P", "--no-patch", "HEAD"])).stdout,
    ).toBe(`${head} ${incoming}`);
    expect(await setup.observedHooks()).toBe("pre-commit:MERGE_HEAD=present\n");
  });

  it("preserves both existing hook commands across repeated initialization", async () => {
    const setup = await fixture();
    const second = await setup.initialize();
    expect(second.exitCode, second.stderr || second.stdout).toBe(0);
    await setup.repository.write(
      "ordinary.ts",
      "export const ordinary = true;\n",
    );
    await setup.git(["add", "--", "ordinary.ts"]);
    const committed = await setup.git([
      "commit",
      "--message",
      "ordinary change",
    ]);
    expect(committed.exitCode, committed.stdout + committed.stderr).toBe(0);
    await setup.git(["switch", "incoming"]);
    await setup.repository.write(
      "incoming.ts",
      "export const incoming = true;\n",
    );
    await setup.commitFixture("incoming change");
    await setup.git(["switch", "main"]);

    const merged = await setup.git([
      "merge",
      "--no-edit",
      "--no-ff",
      "incoming",
    ]);

    expect(merged.exitCode, merged.stdout + merged.stderr).toBe(0);
    expect(await setup.observedHooks()).toBe(
      "pre-commit:MERGE_HEAD=absent\npre-merge-commit:MERGE_HEAD=absent\n",
    );
  });

  it("runs the installed merge hook from a project subfolder", async () => {
    const setup = await fixture("web");
    await setup.git(["switch", "incoming"]);
    await setup.repository.write(
      "web/incoming-caller.ts",
      "import { advisoryLabel } from './summarize';\nexport const label = advisoryLabel();\n",
    );
    await setup.commitFixture("new subfolder caller");
    await setup.git(["switch", "main"]);
    await setup.repository.write(
      "web/summarize.ts",
      "export const advisoryLabelRenamed = () => 'label';\n",
    );
    await setup.commitFixture("renamed subfolder export");
    const head = (await setup.git(["rev-parse", "HEAD"])).stdout;

    const merged = await setup.git(
      ["merge", "--no-edit", "--no-ff", "incoming"],
      setup.projectRoot,
    );

    expect(merged.exitCode, merged.stdout + merged.stderr).not.toBe(0);
    expect(merged.stdout + merged.stderr).toContain("TS2305");
    expect(merged.stdout + merged.stderr).toContain("web/incoming-caller.ts");
    expect((await setup.git(["rev-parse", "HEAD"])).stdout).toBe(head);
  });

  it("installs and runs the merge hook inside a linked worktree", async () => {
    const setup = await fixture();
    await setup.git(["switch", "incoming"]);
    await setup.repository.write(
      "incoming-caller.ts",
      "import { advisoryLabel } from './summarize';\nexport const label = advisoryLabel();\n",
    );
    await setup.commitFixture("new linked caller");
    const incoming = (await setup.git(["rev-parse", "HEAD"])).stdout;
    await setup.git(["switch", "main"]);
    await setup.repository.write(
      "summarize.ts",
      "export const advisoryLabelRenamed = () => 'label';\n",
    );
    await setup.commitFixture("renamed linked export");
    const head = (await setup.git(["rev-parse", "HEAD"])).stdout;
    const worktree = await mkdtemp(join(tmpdir(), "zedbee-hook-worktree-"));
    onTestFinished(() => rm(worktree, { recursive: true, force: true }));
    const added = await setup.git([
      "worktree",
      "add",
      "-b",
      "linked-main",
      worktree,
      "main",
    ]);
    expect(added.exitCode, added.stderr).toBe(0);
    // The fixture's lockfile references a registry closed after the first install.
    await rm(join(worktree, "package-lock.json"), { force: true });
    await installPackedFixture(
      tarballPath,
      packageRoot,
      worktree,
      join(packDirectory, "linked-install-cache"),
    );
    const initialized = await execa(
      process.execPath,
      [
        join(worktree, "node_modules/zedbee/dist/cli.js"),
        "init",
        "--profile",
        "recommended",
        "--checks",
        "types",
        "--hook",
        "raw",
        "--yes",
        "--format",
        "json",
      ],
      {
        cwd: worktree,
        env: setup.environment,
        reject: false,
        stdin: "ignore",
      },
    );
    expect(initialized.exitCode, initialized.stdout + initialized.stderr).toBe(
      0,
    );

    const merged = await setup.git(
      ["merge", "--no-edit", "--no-ff", "incoming"],
      worktree,
    );

    expect(merged.exitCode, merged.stdout + merged.stderr).not.toBe(0);
    expect(merged.stdout + merged.stderr).toContain("TS2305");
    expect((await setup.git(["rev-parse", "HEAD"], worktree)).stdout).toBe(
      head,
    );
    const metadata = await setup.git(
      ["rev-parse", "--git-path", "MERGE_HEAD"],
      worktree,
    );
    expect(await readFile(metadata.stdout, "utf8")).toBe(`${incoming}\n`);
  });
});
