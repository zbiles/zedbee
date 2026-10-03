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

it("reports export, signature, type, and deletion breakages in unchanged TypeScript 5.9.3 files", async () => {
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
    await mkdir(join(scratch, "extension"));
    await writeFile(
      join(scratch, "extension/package.json"),
      JSON.stringify({ name: "unrelated-extension", private: true }),
    );
    await writeFile(
      join(scratch, "extension/tsconfig.json"),
      JSON.stringify({ compilerOptions: { strict: true }, include: ["*.ts"] }),
    );
    await writeFile(
      join(scratch, "extension/existing.ts"),
      'export const existing: number = "debt";\n',
    );
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
    interface ExpectedFinding {
      rule: string;
      file: string;
      line: number;
      staged: boolean;
    }
    const scan = async (
      expected: readonly ExpectedFinding[],
      args: string[] = [],
      cacheDirectory = "scan-cache",
    ) => {
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
      const typeChecks = report.checks.filter(
        (check: { checkId: string }) => check.checkId === "types",
      );
      expect(typeChecks, result.stdout).toHaveLength(1);
      const types = typeChecks[0];
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
      ).toEqual(expected);
    };
    const renamedFindings = [
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
    ];
    await scan(renamedFindings);
    await scan(renamedFindings); // Warm service/cache must preserve the same findings.
    await scan(renamedFindings, ["--no-service"], "fresh-cache");
    await commit();
    await scan(renamedFindings, ["--base", "HEAD~1"]);
    for (const scenario of [
      {
        before: "export function advisoryLabel() { return 'label'; }\n",
        after:
          "export function advisoryLabel(required: string) { return required; }\n",
        caller: importer,
        rule: "typescript/TS2554",
        line: 2,
      },
      {
        before: "export interface Advisory { label: string }\n",
        after: "export interface Advisory { label: string; rank: number }\n",
        caller:
          "import type { Advisory } from './summarize';\nexport const advisory: Advisory = { label: 'label' };\n",
        rule: "typescript/TS2741",
        line: 2,
      },
      {
        before:
          "export const advisoryLabel = () => 'label';\nexport const remaining = 1;\n",
        after: "export const remaining = 1;\n",
        caller: importer,
        rule: "typescript/TS2305",
        line: 1,
      },
      {
        before: "export const advisoryLabel = () => 'label';\n",
        after: undefined,
        caller: importer,
        rule: "typescript/TS2307",
        line: 1,
      },
    ]) {
      await writeFile(join(web, "summarize.ts"), scenario.before);
      await writeFile(join(web, "shape-evidence.tsx"), scenario.caller);
      await writeFile(join(web, "summarize.test.ts"), scenario.caller);
      await git([
        "add",
        "web/summarize.ts",
        "web/shape-evidence.tsx",
        "web/summarize.test.ts",
      ]);
      await commit();
      expect((await tsc()).exitCode).toBe(0);
      if (scenario.after === undefined) await rm(join(web, "summarize.ts"));
      else await writeFile(join(web, "summarize.ts"), scenario.after);
      await git(["add", "--", "web/summarize.ts"]);
      const projectResult = await tsc();
      expect(projectResult.exitCode, projectResult.stdout).toBe(2);
      expect(projectResult.stdout.match(/error TS\d+/gu)).toHaveLength(2);
      // Restore the live declaration, including a staged deletion, to test snapshot isolation.
      await writeFile(join(web, "summarize.ts"), scenario.before);
      const expected = [
        {
          rule: scenario.rule,
          file: "web/shape-evidence.tsx",
          line: scenario.line,
          staged: true,
        },
        {
          rule: scenario.rule,
          file: "web/summarize.test.ts",
          line: scenario.line,
          staged: true,
        },
      ];
      await scan(expected);
      await scan(expected, ["--no-service"], `fresh-${scenario.rule}`);
      await commit();
      await scan(expected, ["--base", "HEAD~1"]);
    }
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
