import { access, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  executeInitCommand,
  type InitCommandOptions,
  type InitCommandDependencies,
} from "../../src/commands/init.js";
import { runScan } from "../../src/scan/run-scan.js";
import { inspectRepository } from "../../src/inspection/inspect-repository.js";
import { applyInitProposal } from "../../src/init/write-config.js";
import type { InitProposal } from "../../src/init/types.js";
import { createGitRepository } from "../helpers/git-repository.js";

const path = ".github/workflows/zedbee.yml";
async function fixture() {
  const repo = await createGitRepository("zedbee-init-workflow-");
  await repo.write("package.json", '{"name":"fixture","private":true}\n');
  return repo;
}
async function setup(
  root: string,
  workflow?: "github" | "none",
  yes = true,
  confirm?: InitCommandDependencies["confirm"],
) {
  const stdout: string[] = [],
    stderr: string[] = [];
  const code = await executeInitCommand(
    {
      cwd: root,
      profile: "fast",
      hook: "none",
      yes,
      format: confirm ? "text" : "json",
      color: false,
      animations: false,
      ...(workflow === undefined ? {} : { workflow }),
    } as InitCommandOptions,
    {
      stdinIsTTY: !!confirm,
      stdoutIsTTY: !!confirm,
      width: 100,
      env: { ZEDBEE_TELEMETRY_DISABLED: "1" },
      writeStdout: (s) => stdout.push(s),
      writeStderr: (s) => stderr.push(s),
    },
    {
      resolveRepositoryRoot: async () => root,
      inspect: inspectRepository,
      confirm: confirm ?? (async () => false),
    },
  );
  return { code, stdout: stdout.join(""), stderr: stderr.join("") };
}

describe("GitHub workflow initialization", () => {
  it.each([false, true])(
    "sets modern Yarn's CI lockfile policy explicitly (lockfile: %s)",
    async (locked) => {
      const repo = await fixture();
      await repo.write(
        "package.json",
        '{"name":"root","packageManager":"yarn@4.9.2","workspaces":["packages/*"],"private":true}',
      );
      if (locked) await repo.write("yarn.lock", "__metadata:\n  version: 8\n");
      const result = await setup(repo.root, "github");
      expect(result.code, result.stderr).toBe(0);
      const step = parse(
        await readFile(join(repo.root, path), "utf8"),
      ).jobs.scan.steps.find((step: any) => step["working-directory"] === ".");
      expect(step.env.YARN_ENABLE_IMMUTABLE_INSTALLS).toBe(
        locked ? "true" : "false",
      );
      expect(step.run.endsWith("--mode=skip-build")).toBe(true);
      expect(step.run.includes("--immutable")).toBe(locked);
    },
  );

  it("requires a declared version before generating a modern Yarn install", async () => {
    const repo = await fixture();
    await repo.write("yarn.lock", "__metadata:\n  version: 8\n");
    const result = await setup(repo.root, "github");
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/package.manager|dependency installation/i);
    await expect(access(join(repo.root, path))).rejects.toThrow();
    expect((await setup(repo.root, "none")).code).toBe(0);
  });
  it("does not allow folder names to inject GitHub expressions into a generated workflow", async () => {
    const repo = await fixture();
    await repo.write("web${{ secrets.TOKEN }}/package.json", '{"name":"web"}');
    await repo.write(
      "web${{ secrets.TOKEN }}/package-lock.json",
      '{"lockfileVersion":3,"packages":{}}',
    );
    const result = await setup(repo.root, "github");
    expect(result.code).toBe(2);
    await expect(access(join(repo.root, path))).rejects.toThrow();
  });
  it("preserves the alternative workflow filename", async () => {
    const repo = await fixture();
    await repo.write(".github/workflows/zedbee.yaml", "name: Existing\n");
    expect((await setup(repo.root, "github")).code).toBe(0);
    await expect(access(join(repo.root, path))).rejects.toThrow();
    expect(await repo.read(".github/workflows/zedbee.yaml")).toBe(
      "name: Existing\n",
    );
  });

  it("creates a workflow that passes the configured formatting check", async () => {
    const repo = await fixture();
    await repo.commitAll("baseline");
    const result = await setup(repo.root, "github");
    expect(result.code, result.stderr).toBe(0);
    expect((await repo.git(["add", ".zedbeerc.jsonc", path])).exitCode).toBe(0);
    const report = await runScan({ repositoryRoot: repo.root, cache: false });
    expect(report, JSON.stringify(report)).toMatchObject({
      outcome: "pass",
      exitCode: 0,
    });
  });

  it("uses per-version Yarn invocations for independent Classic and modern projects", async () => {
    const repo = await fixture();
    await repo.write(
      "classic/package.json",
      '{"name":"classic","packageManager":"yarn@1.22.22"}',
    );
    await repo.write("classic/yarn.lock", "# yarn lockfile v1\n");
    await repo.write(
      "modern/package.json",
      '{"name":"modern","packageManager":"yarn@4.9.2"}',
    );
    await repo.write("modern/yarn.lock", "__metadata:\n  version: 8\n");
    const result = await setup(repo.root, "github");
    expect(result.code, result.stderr).toBe(0);
    const steps = parse(await readFile(join(repo.root, path), "utf8")).jobs.scan
      .steps;
    const classic = steps.find(
      (step: any) => step["working-directory"] === "classic",
    );
    const modern = steps.find(
      (step: any) => step["working-directory"] === "modern",
    );
    expect(classic.run).toBe(
      "npm exec --yes --package=yarn@1.22.22 -- yarn install --frozen-lockfile --ignore-scripts",
    );
    expect(modern).toMatchObject({
      run: "npm exec --yes --package=@yarnpkg/cli-dist@4.9.2 -- yarn install --immutable --mode=skip-build",
      env: { YARN_ENABLE_SCRIPTS: "false", YARN_NODE_LINKER: "node-modules" },
    });
    expect(steps.filter((step: any) => step.run?.includes("--global"))).toEqual(
      [],
    );
  });

  it("installs an independent nested project even when the repository root has a lockfile", async () => {
    const repo = await fixture();
    await repo.write(
      "package-lock.json",
      '{"lockfileVersion":3,"packages":{}}',
    );
    await repo.write(
      "app/package.json",
      '{"name":"app","packageManager":"pnpm@10.18.0","dependencies":{"typescript":"6.0.3"}}',
    );
    const result = await setup(repo.root, "github");
    expect(result.code, result.stderr).toBe(0);
    const steps = parse(await readFile(join(repo.root, path), "utf8")).jobs.scan
      .steps;
    expect(steps).toContainEqual(
      expect.objectContaining({
        "working-directory": "app",
        run: "npm exec --yes --package=pnpm@10.18.0 -- pnpm install --ignore-scripts",
      }),
    );
  });
  it("installs a declared workspace once from its owning root", async () => {
    const repo = await fixture();
    await repo.write(
      "package.json",
      '{"name":"root","workspaces":["packages/*"],"private":true}',
    );
    await repo.write(
      "package-lock.json",
      '{"lockfileVersion":3,"packages":{}}',
    );
    await repo.write(
      "packages/app/package.json",
      '{"name":"app","dependencies":{"typescript":"6.0.3"}}',
    );
    const result = await setup(repo.root, "github");
    expect(result.code, result.stderr).toBe(0);
    const installs = parse(
      await readFile(join(repo.root, path), "utf8"),
    ).jobs.scan.steps.filter(
      (step: any) => step["working-directory"] !== undefined,
    );
    expect(installs).toEqual([
      expect.objectContaining({
        "working-directory": ".",
        run: "npm ci --ignore-scripts",
      }),
    ]);
  });

  it("leaves workflow creation opt-in for noninteractive setup", async () => {
    const repo = await fixture();
    expect((await setup(repo.root)).code).toBe(0);
    await expect(access(join(repo.root, path))).rejects.toThrow();
  });
  it("previews then transactionally writes a runnable pull-request workflow", async () => {
    const repo = await fixture();
    const preview = await setup(repo.root, "github", false);
    expect(preview.code, preview.stderr).toBe(0);
    expect(JSON.parse(preview.stdout).proposal.files).toContainEqual(
      expect.objectContaining({ relativePath: path }),
    );
    await expect(access(join(repo.root, path))).rejects.toThrow();
    const applied = await setup(repo.root, "github");
    expect(applied.code, applied.stderr).toBe(0);
    expect(JSON.parse(applied.stdout).files).toContain(path);
    const workflow = parse(await readFile(join(repo.root, path), "utf8"));
    expect(workflow.on).toHaveProperty("pull_request");
    expect(workflow.permissions).toEqual({ contents: "read" });
    const steps = workflow.jobs.scan.steps;
    expect(
      steps.find((step: any) => step.uses?.startsWith("actions/checkout@")),
    ).toMatchObject({
      with: {
        "fetch-depth": 0,
        "persist-credentials": false,
        ref: "${{ github.event.pull_request.head.sha }}",
      },
    });
    expect(
      steps.find((step: any) => step.uses?.startsWith("zbiles/zedbee/")),
    ).toMatchObject({
      uses: expect.stringMatching(
        /^zbiles\/zedbee\/\.github\/actions\/scan@[a-f0-9]{40}$/,
      ),
      with: {
        version: expect.stringMatching(/^\d+\.\d+\.\d+/),
        "base-ref": "${{ github.event.pull_request.base.sha }}",
        "report-format": "sarif",
      },
    });
  });
  it("preserves an existing workflow on repeated explicit setup", async () => {
    const repo = await fixture();
    await repo.write(path, "# hand maintained\nname: Custom PR checks\n");
    const result = await setup(repo.root, "github");
    expect(result.code, result.stderr).toBe(0);
    expect(await readFile(join(repo.root, path), "utf8")).toBe(
      "# hand maintained\nname: Custom PR checks\n",
    );
    expect(JSON.parse(result.stdout).files).not.toContain(path);
    expect(JSON.parse(result.stdout).proposal.workflowMessage).toMatch(
      /existing.*preserv/i,
    );
  });
  it("rejects a workflow ancestor symlink without writing outside the repository", async () => {
    const repo = await fixture(),
      outside = await fixture();
    await symlink(
      outside.root,
      join(repo.root, ".github"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const result = await setup(repo.root, "github");
    expect(result.code).toBe(2);
    await expect(
      access(join(outside.root, "workflows/zedbee.yml")),
    ).rejects.toThrow();
    await expect(access(join(repo.root, ".zedbeerc.jsonc"))).rejects.toThrow();
  });
  it("keeps workflow writes inside the reviewed proposal and rejects a stale destination", async () => {
    const repo = await fixture();
    const result = await setup(
      repo.root,
      undefined,
      false,
      async (proposal, _options, select) => {
        const selected = select(
          proposal.profile,
          undefined,
          "block",
          "none",
          undefined,
          false,
          undefined,
          undefined,
          "github",
        );
        expect(selected.files.some((file) => file.relativePath === path)).toBe(
          true,
        );
        await repo.write(path, "name: Added after preview\n");
        return selected;
      },
    );
    expect(result.code, result.stdout).toBe(2);
    expect(await readFile(join(repo.root, path), "utf8")).toBe(
      "name: Added after preview\n",
    );
    await expect(access(join(repo.root, ".zedbeerc.jsonc"))).rejects.toThrow();
  });
  it("rolls back config when a reviewed workflow write cannot complete", async () => {
    const repo = await fixture();
    let captured: InitProposal | undefined;
    await setup(repo.root, "github", false, async (proposal) => {
      captured = proposal;
      return false;
    });
    expect(captured?.files.some((file) => file.relativePath === path)).toBe(
      true,
    );
    await expect(
      applyInitProposal(captured!, {
        beforeWrite(_index, change) {
          if (change.relativePath === path)
            throw new Error("injected workflow write failure");
        },
      }),
    ).rejects.toThrow();
    await expect(access(join(repo.root, ".zedbeerc.jsonc"))).rejects.toThrow();
    await expect(access(join(repo.root, path))).rejects.toThrow();
  });
  it("installs dependencies in nested lockfile folders without interpolating paths into shell commands", async () => {
    const repo = await fixture();
    await repo.write(
      "web folder/package.json",
      '{"name":"web","private":true}\n',
    );
    await repo.write(
      "web folder/package-lock.json",
      '{"lockfileVersion":3,"packages":{}}\n',
    );
    const result = await setup(repo.root, "github");
    expect(result.code, result.stderr).toBe(0);
    const workflow = parse(await readFile(join(repo.root, path), "utf8"));
    expect(workflow.jobs.scan.steps).toContainEqual(
      expect.objectContaining({
        "working-directory": "web folder",
        run: expect.stringMatching(/npm ci.*--ignore-scripts/),
      }),
    );
  });
});
