import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { describe, expect, it, onTestFinished } from "vitest";
import { windowsManagerInvocation } from "../../src/init/install-dependency.mjs";
import { preparePlugin } from "../../scripts/prepare-plugin.mjs";

describe("packed Swarm installer", () => {
  it.skipIf(process.platform === "win32").each(["SIGINT", "SIGTERM"] as const)(
    "terminates the packed manager process tree before exiting on %s",
    async (signal) => {
      const root = await realpath(
        await mkdtemp(join(tmpdir(), "zedbee-installer-signal-")),
      );
      const archive = await preparePlugin(root);
      const plugin = join(root, "plugin");
      await mkdir(plugin);
      await execa("unzip", ["-q", archive.archive, "-d", plugin]);
      const bin = join(root, "bin");
      await mkdir(bin);
      const marker = join(root, "orphan-marker");
      const ready = join(root, "descendant-ready");
      const managerPid = join(root, "manager-pid");
      const descendant = join(root, "descendant.cjs");
      await writeFile(
        descendant,
        `const fs = require("node:fs"); fs.writeFileSync(${JSON.stringify(ready)}, String(process.pid)); setTimeout(() => fs.writeFileSync(${JSON.stringify(marker)}, "orphaned manager descendant"), 400);`,
      );
      const manager = join(bin, "npm");
      await writeFile(
        manager,
        `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(managerPid)}, String(process.pid)); require("node:child_process").spawn(process.execPath, [${JSON.stringify(descendant)}], { stdio: "ignore" }); setInterval(() => {}, 1000);`,
      );
      await chmod(manager, 0o755);
      const helper = spawn(
        process.execPath,
        [
          join(plugin, "scripts/install-dependency.mjs"),
          "--manager",
          "npm",
          "--project-root",
          root,
          "--package",
          "zedbee@0.1.0-beta.13",
        ],
        {
          env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
          stdio: "ignore",
        },
      );
      const closed = new Promise<{
        code: number | null;
        signal: NodeJS.Signals | null;
      }>((resolve, reject) => {
        helper.once("error", reject);
        helper.once("close", (code, signal) => resolve({ code, signal }));
      });
      onTestFinished(async () => {
        helper.kill("SIGKILL");
        const pid = Number(await readFile(managerPid, "utf8").catch(() => "0"));
        if (pid > 0) {
          try {
            process.kill(-pid, "SIGKILL");
          } catch {}
        }
        await rm(root, { recursive: true, force: true });
      });
      let started = false;
      for (let attempt = 0; attempt < 500; attempt++) {
        if (
          await readFile(ready).then(
            () => true,
            () => false,
          )
        ) {
          started = true;
          break;
        }
        await delay(10);
      }
      expect(started).toBe(true);
      helper.kill(signal);
      const exit = await closed;
      await delay(650);
      await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
      expect(exit).toEqual({
        code: signal === "SIGINT" ? 130 : 143,
        signal: null,
      });
    },
  );

  it.each(["npm", "pnpm", "yarn"] as const)(
    "resolves standard Windows %s shims without evaluating a shell",
    async (manager) => {
      const root = await mkdtemp(join(tmpdir(), "zedbee-windows-shim-"));
      onTestFinished(() => rm(root, { recursive: true, force: true }));
      const script = join(
        root,
        "node_modules",
        "corepack",
        "dist",
        `${manager}.js`,
      );
      await mkdir(join(root, "node_modules", "corepack", "dist"), {
        recursive: true,
      });
      await writeFile(script, "// Trusted installed manager entry.");
      await writeFile(
        join(root, `${manager}.cmd`),
        `@ECHO OFF\n"%dp0%\\node.exe" "%dp0%\\node_modules\\corepack\\dist\\${manager}.js" %*\n`,
      );
      expect(await windowsManagerInvocation(manager, root)).toEqual({
        command: process.execPath,
        args: [script],
      });
      await writeFile(
        join(root, `${manager}.cmd`),
        "@echo arbitrary command text",
      );
      await expect(windowsManagerInvocation(manager, root)).rejects.toThrow(
        "Cannot safely resolve",
      );
    },
  );

  it.each(["npm", "pnpm", "yarn", "bun"])(
    "executes the packaged %s policy without repository executable configuration",
    async (manager) => {
      const root = await realpath(
        await mkdtemp(join(tmpdir(), "zedbee-packed-install-")),
      );
      onTestFinished(() => rm(root, { recursive: true, force: true }));
      const archive = await preparePlugin(root);
      const plugin = join(root, "plugin");
      await mkdir(plugin);
      await execa("unzip", ["-q", archive.archive, "-d", plugin]);
      const project = join(root, "project");
      const bin = join(root, "bin");
      await mkdir(project);
      await mkdir(bin);
      const sentinel = join(project, "EXECUTED");
      const log = join(root, "calls.jsonl");
      await writeFile(
        join(project, "package.json"),
        JSON.stringify({ name: "project", packageManager: "yarn@9.9.9" }),
      );
      await writeFile(join(project, ".yarnrc"), 'yarn-path "./hostile.cjs"\n');
      await writeFile(
        join(project, ".yarnrc.yml"),
        "yarnPath: ./hostile.cjs\nplugins:\n  - path: ./hostile.cjs\n",
      );
      await writeFile(
        join(project, ".pnpmfile.cjs"),
        'require("node:fs").writeFileSync(' +
          JSON.stringify(sentinel) +
          ', "hook");',
      );
      await writeFile(
        join(project, "hostile.cjs"),
        'require("node:fs").writeFileSync(' +
          JSON.stringify(sentinel) +
          ', "delegated");',
      );
      const executable = join(bin, manager);
      await writeFile(
        executable,
        `#!${process.execPath}
const fs = require("node:fs"); const path = require("node:path");
const args = process.argv.slice(2); const env = process.env;
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, cwd: process.cwd() }) + "\\n");
const safe = env.COREPACK_ENABLE_PROJECT_SPEC === "0" && env.COREPACK_ENABLE_AUTO_PIN === "0" && env.npm_config_ignore_scripts === "true";
let managerSafe = true;
if (${JSON.stringify(manager)} === "yarn") {
  managerSafe = env.YARN_IGNORE_PATH === "1" && /^\\.zedbee-/.test(env.YARN_RC_FILENAME) && env.YARN_ENABLE_SCRIPTS === "false" && env.YARN_NODE_LINKER === "node-modules";
  if (args[0] === "--version") { if (process.cwd() === ${JSON.stringify(project)}) managerSafe = false; }
  else managerSafe = managerSafe && args.includes("--no-default-rc") && args.includes("--ignore-scripts");
}
if (${JSON.stringify(manager)} === "pnpm") managerSafe = args.includes("--ignore-pnpmfile") && args.includes("--manage-package-manager-versions=false") && args.includes("--ignore-scripts") && args.includes("--workspace-root");
if (!safe || !managerSafe) { fs.writeFileSync(${JSON.stringify(sentinel)}, "unsafe"); process.exit(71); }
if (args[0] === "--version") console.log("1.22.22");
else if (!args.includes("zedbee@0.1.0-beta.13")) process.exit(72);
`,
      );
      await chmod(executable, 0o755);
      const control = await execa(executable, ["add", "zedbee@0.1.0-beta.13"], {
        cwd: project,
        env: { COREPACK_ENABLE_PROJECT_SPEC: "1" },
        reject: false,
      });
      expect(control.exitCode).toBe(71);
      expect(await readFile(sentinel, "utf8")).toBe("unsafe");
      await rm(sentinel);
      await rm(log);
      await execa(
        process.execPath,
        [
          join(plugin, "scripts/install-dependency.mjs"),
          "--manager",
          manager,
          "--project-root",
          project,
          "--package",
          "zedbee@0.1.0-beta.13",
          "--workspace-root",
        ],
        { env: { PATH: `${bin}:${process.env.PATH}` } },
      );
      expect(await readFile(log, "utf8")).toContain("zedbee@0.1.0-beta.13");
      await expect(readFile(sentinel)).rejects.toMatchObject({
        code: "ENOENT",
      });
      const calls = (await readFile(log, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(calls).toHaveLength(manager === "yarn" ? 2 : 1);
      expect(calls.at(-1).cwd).toBe(project);
      if (manager === "yarn") expect(calls[0].cwd).not.toBe(project);
    },
  );
});
