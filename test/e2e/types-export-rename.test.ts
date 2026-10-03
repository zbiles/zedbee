import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execa } from "execa";
import { expect, it } from "vitest";
import { CHECK_IDS } from "../../src/config/schema.js";
import {
  installPackedFixture,
  sharedPackedTarball,
} from "../helpers/packed-install.js";

const root = resolve(import.meta.dirname, "../..");

it("reports exported-rename errors throughout a nested TypeScript 5.9.3 project", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "zedbee-types-export-rename-"));
  const web = join(scratch, "web");
  const cli = join(web, "node_modules/zedbee/dist/cli.js");
  try {
    await mkdir(web);
    const pack = async (directory: string) => {
      const packed = await execa(
        "npm",
        [
          "pack",
          directory,
          "--json",
          "--ignore-scripts",
          "--pack-destination",
          scratch,
        ],
        {
          cwd: web,
          stdin: "ignore",
          env: { npm_config_cache: join(scratch, "npm-cache") },
        },
      );
      return join(scratch, JSON.parse(packed.stdout)[0].filename as string);
    };
    const tarball = sharedPackedTarball()?.path ?? (await pack(root));
    const olderTypescript = await pack(
      join(root, "node_modules/typescript-5-9-3"),
    );
    await writeFile(
      join(web, "package.json"),
      JSON.stringify({
        name: "types-export-rename-consumer",
        private: true,
        devDependencies: { typescript: `file:${olderTypescript}` },
      }),
    );
    await installPackedFixture(
      tarball,
      root,
      web,
      join(scratch, "install-cache"),
      { reuseSharedInstall: false },
    );
    await writeFile(join(scratch, ".gitignore"), "node_modules/\n");
    await writeFile(
      join(scratch, ".zedbeerc.jsonc"),
      JSON.stringify({
        schemaVersion: 1,
        profile: "recommended",
        checks: Object.fromEntries(
          CHECK_IDS.map((id) => [
            id,
            { severity: id === "types" ? "error" : "off" },
          ]),
        ),
      }),
    );
    await writeFile(
      join(web, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
        },
        include: ["**/*.ts", "**/*.tsx"],
      }),
    );
    const summarize =
      "export const advisoryLabel = () => 'label';\n\nexport const label = advisoryLabel();\n";
    await writeFile(join(web, "summarize.ts"), summarize);
    const importer =
      "import { advisoryLabel } from './summarize';\nexport const label = advisoryLabel();\n";
    await writeFile(join(web, "shape-evidence.tsx"), importer);
    await writeFile(join(web, "summarize.test.ts"), importer);
    const git = (args: string[]) => execa("git", args, { cwd: scratch });
    const commit = () =>
      git([
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "-c",
        "core.hooksPath=/dev/null",
        "commit",
        "--quiet",
        "-m",
        "fixture",
      ]);
    await git(["init", "--quiet"]);
    await git(["add", "."]);
    await commit();
    const tsc = () =>
      execa(
        process.execPath,
        [join(web, "node_modules/typescript/bin/tsc"), "--pretty", "false"],
        { cwd: web, reject: false },
      );
    expect((await tsc()).exitCode).toBe(0);
    await writeFile(
      join(web, "summarize.ts"),
      summarize.replace(
        "export const advisoryLabel =",
        "export const advisoryLabelRenamed =",
      ),
    );
    await git(["add", "web/summarize.ts"]);
    const projectResult = await tsc();
    expect(projectResult.exitCode).toBe(2);
    expect(projectResult.stdout.match(/error TS\d+/gu)).toHaveLength(3);
    // An unstaged repair must not hide the staged export rename.
    await writeFile(join(web, "summarize.ts"), summarize);
    const scan = async (args: string[] = [], cacheDirectory = "scan-cache") => {
      const result = await execa(
        process.execPath,
        [cli, "scan", ...args, "--format", "json", "--no-source"],
        {
          cwd: scratch,
          stdin: "ignore",
          reject: false,
          env: { XDG_CACHE_HOME: join(scratch, cacheDirectory) },
        },
      );
      expect(result.exitCode, result.stdout || result.stderr).toBe(1);
      const report = JSON.parse(result.stdout);
      const types = report.checks.find(
        (check: { checkId: string }) => check.checkId === "types",
      );
      expect(types, result.stdout).toMatchObject({
        target: "web",
        status: "completed",
      });
      expect(
        types.findings.map(
          (finding: {
            rule: string;
            location: { file: string; startLine: number };
            attribution: { staged: boolean };
          }) => ({
            rule: finding.rule,
            file: finding.location.file,
            line: finding.location.startLine,
            staged: finding.attribution.staged,
          }),
        ),
      ).toEqual([
        {
          rule: "typescript/TS2305",
          file: "web/shape-evidence.tsx",
          line: 1,
          staged: true,
        },
        {
          rule: "typescript/TS2305",
          file: "web/summarize.test.ts",
          line: 1,
          staged: true,
        },
        {
          rule: "typescript/TS2304",
          file: "web/summarize.ts",
          line: 3,
          staged: true,
        },
      ]);
    };
    await scan();
    await scan(); // Warm service/cache must preserve the same findings.
    await scan(["--no-service"], "fresh-cache");
    await commit();
    await scan(["--base", "HEAD~1"]);
    const manifest = JSON.parse(
      await readFile(join(web, "node_modules/typescript/package.json"), "utf8"),
    );
    expect(manifest.version).toBe("5.9.3");
  } finally {
    await execa(process.execPath, [cli, "service", "stop"], {
      cwd: scratch,
      reject: false,
    }).catch(() => {});
    await rm(scratch, { recursive: true, force: true });
  }
});
