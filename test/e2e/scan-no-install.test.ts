import { afterAll, beforeAll, expect, it, onTestFinished } from "vitest";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { createGitRepository } from "../helpers/git-repository.js";
import {
  installPackedFixture,
  sharedPackedTarball,
} from "../helpers/packed-install.js";
import { CHECK_IDS } from "../../src/config/schema.js";
const packageRoot = join(import.meta.dirname, "../..");
let scratch: string, cli: string;
beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "zedbee-no-install-pack-"));
  const shared = sharedPackedTarball();
  let tarball = shared?.path;
  if (tarball === undefined) {
    const packed = await execa(
      "npm",
      ["pack", "--json", "--ignore-scripts", "--pack-destination", scratch],
      {
        cwd: packageRoot,
        env: { npm_config_cache: join(scratch, "pack-cache") },
      },
    );
    tarball = join(scratch, JSON.parse(packed.stdout)[0].filename);
  }
  const installation = join(scratch, "installed");
  await mkdir(installation);
  await writeFile(
    join(installation, "package.json"),
    JSON.stringify({
      name: "scan-no-install-fixture",
      version: "1.0.0",
      private: true,
    }),
  );
  await installPackedFixture(
    tarball!,
    packageRoot,
    installation,
    join(scratch, "install-cache"),
  );
  cli = join(installation, "node_modules/zedbee/dist/cli.js");
});
afterAll(() => rm(scratch, { recursive: true, force: true }));
it.each(["local", "service"] as const)(
  "never invokes an installer during managed %s scans of the packed CLI",
  async (execution) => {
    const repo = await createGitRepository("zedbee-installer-guard-");
    const runtime = await mkdtemp(
      join(process.platform === "darwin" ? "/private/tmp" : tmpdir(), "zsi-"),
    );
    const bin = join(runtime, "sentinels"),
      log = join(runtime, "manager-roles");
    await mkdir(bin);
    const env = {
      ...process.env,
      PATH: `${bin}${process.platform === "win32" ? ";" : ":"}${process.env.PATH}`,
      ZEDBEE_INSTALL_SENTINEL_LOG: log,
      ZEDBEE_TEST_RUN_KIND: "scan-installer-guard",
      ZEDBEE_TELEMETRY_DISABLED: "1",
      ZEDBEE_NO_UPDATE_CHECK: "1",
      TMPDIR: runtime,
      TMP: runtime,
      TEMP: runtime,
      XDG_CACHE_HOME: join(runtime, "cache"),
      npm_config_offline: "true",
      npm_config_registry: "http://127.0.0.1:1/",
    };
    for (const manager of ["npm", "yarn", "pnpm", "bun"]) {
      const script = join(bin, `${manager}.cjs`);
      await writeFile(
        script,
        `require('node:fs').appendFileSync(process.env.ZEDBEE_INSTALL_SENTINEL_LOG,${JSON.stringify(manager + "\n")});process.exitCode=97;`,
      );
      await writeFile(
        join(bin, process.platform === "win32" ? `${manager}.cmd` : manager),
        process.platform === "win32"
          ? `@"${process.execPath}" "%~dp0${manager}.cjs" %*\r\n`
          : `#!${process.execPath}\nrequire(${JSON.stringify(script)});\n`,
        { mode: 0o755 },
      );
    }
    const invoke = (args: string[]) =>
      execa(process.execPath, [cli, ...args], {
        cwd: repo.root,
        env,
        reject: false,
        stdin: "ignore",
      });
    onTestFinished(async () => {
      const stopped = await invoke(["service", "stop"]);
      expect(stopped.exitCode, stopped.stderr).toBe(0);
      await rm(runtime, { recursive: true, force: true });
    });
    // A deliberate setup probe proves all four recording/failing shims are reached.
    for (const manager of ["npm", "yarn", "pnpm", "bun"]) {
      const result = await execa(manager, ["sentinel-control"], {
        cwd: repo.root,
        env,
        reject: false,
      });
      expect(result.exitCode).toBe(97);
    }
    expect(await readFile(log, "utf8")).toBe("npm\nyarn\npnpm\nbun\n");
    await writeFile(log, "");
    await repo.write(
      "package.json",
      JSON.stringify({
        name: "guard",
        private: true,
        scripts: { prepare: "npm install should-never-run" },
      }),
    );
    await repo.write(".gitignore", "node_modules/\n");
    await repo.write(
      "tsconfig.json",
      JSON.stringify({
        compilerOptions: {
          strict: true,
          types: [],
          module: "ESNext",
          moduleResolution: "Bundler",
        },
        include: ["src"],
      }),
    );
    await repo.write(
      ".zedbeerc.jsonc",
      JSON.stringify({
        schemaVersion: 1,
        checks: {
          ...Object.fromEntries(CHECK_IDS.map((id) => [id, "off"])),
          types: "error",
        },
      }),
    );
    await repo.write("src/value.ts", "export const value=1;");
    await repo.commitAll("baseline");
    for (const scenario of ["pass", "blocked", "missing"] as const) {
      await repo.write(
        "src/value.ts",
        scenario === "pass"
          ? "export const value=2;"
          : scenario === "blocked"
            ? "export const value:string=1;"
            : 'import {value} from "unavailable-fixture-package"; export {value};',
      );
      await repo.write(
        "package.json",
        JSON.stringify({
          name: "guard",
          private: true,
          ...(scenario === "missing"
            ? { dependencies: { "unavailable-fixture-package": "1.0.0" } }
            : {}),
        }),
      );
      await repo.git(["add", "src/value.ts", "package.json"]);
      const before = (await repo.git(["status", "--porcelain=v1", "-z"]))
        .stdout;
      const index = (await repo.git(["write-tree"])).stdout;
      for (let repetition = 0; repetition < 2; repetition++) {
        const result = await invoke([
          "scan",
          "--hook-invocation",
          "--format",
          "json",
          "--no-source",
          ...(execution === "local" ? ["--no-service"] : []),
        ]);
        const report = JSON.parse(result.stdout);
        expect(report.outcome, result.stderr).toBe(
          scenario === "pass"
            ? "pass"
            : scenario === "blocked"
              ? "blocked"
              : "incomplete",
        );
        expect(result.exitCode).toBe(
          scenario === "pass" ? 0 : scenario === "blocked" ? 1 : 2,
        );
        if (scenario === "missing")
          expect(report.checks).toContainEqual(
            expect.objectContaining({
              error: expect.objectContaining({
                code: "COMPARISON_INSTALLATION_UNAVAILABLE",
              }),
            }),
          );
        expect(await readFile(log, "utf8")).toBe("");
        expect(
          (await repo.git(["status", "--porcelain=v1", "-z"])).stdout,
        ).toBe(before);
        expect((await repo.git(["write-tree"])).stdout).toBe(index);
        await expect(
          readdir(join(repo.root, "node_modules")),
        ).rejects.toMatchObject({ code: "ENOENT" });
      }
    }
  },
);
