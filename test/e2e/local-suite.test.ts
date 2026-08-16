import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGitRepository } from "../helpers/git-repository.js";
import { installPackedFixture } from "../helpers/packed-install.js";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
let packDirectory: string;
let tarballPath: string;

interface JsonFinding {
  rule: string;
  location?: { file: string; startLine?: number };
  attribution: { staged: boolean; evidence: readonly string[] };
}

interface JsonCheck {
  checkId: string;
  status: string;
  findings: JsonFinding[];
  skipReason?: string;
}

interface JsonReport {
  outcome: string;
  exitCode: number;
  checks: JsonCheck[];
}

async function runNpm(args: readonly string[], cwd: string) {
  return execa("npm", args, {
    cwd,
    env: { npm_config_cache: join(packDirectory, "npm-cache") },
    reject: false,
    stdin: "ignore",
  });
}

beforeAll(async () => {
  packDirectory = await mkdtemp(join(tmpdir(), "zedbee-local-suite-pack-"));
  const build = await runNpm(["run", "build"], packageRoot);
  expect(build.exitCode).toBe(0);
  const packed = await runNpm(
    ["pack", "--json", "--ignore-scripts", "--pack-destination", packDirectory],
    packageRoot,
  );
  expect(packed.exitCode).toBe(0);
  const metadata = JSON.parse(packed.stdout) as Array<{ filename: string }>;
  tarballPath = join(packDirectory, metadata[0]!.filename);
}, 30_000);

afterAll(async () => {
  await rm(packDirectory, { recursive: true, force: true });
});

async function installedRepository(
  environments: Readonly<Record<string, string>> = {},
) {
  const repository = await createGitRepository("zedbee-local-suite-");
  await repository.write(
    "package.json",
    JSON.stringify({
      name: "local-suite-fixture",
      version: "1.0.0",
      private: true,
    }),
  );
  await repository.write(".gitignore", "node_modules/\nCONFIG_EXECUTED\n");
  await installPackedFixture(
    tarballPath,
    packageRoot,
    repository.root,
    join(packDirectory, "install-cache"),
  );
  const manifest = JSON.parse(await repository.read("package.json")) as {
    dependencies?: Record<string, string>;
  };
  manifest.dependencies = { ...manifest.dependencies, ...environments };
  await repository.write(
    "package.json",
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  await repository.write(
    "eslint.config.mjs",
    'import { writeFileSync } from "node:fs";\nwriteFileSync("CONFIG_EXECUTED", "yes");\nexport default [];\n',
  );
  return repository;
}

async function runZedbee(repositoryRoot: string) {
  const result = await execa(
    process.execPath,
    [
      join(repositoryRoot, "node_modules", "zedbee", "dist", "cli.js"),
      "scan",
      "--format",
      "json",
    ],
    { cwd: repositoryRoot, reject: false, stdin: "ignore" },
  );
  return { result, report: JSON.parse(result.stdout) as JsonReport };
}

function check(report: JsonReport, id: string): JsonCheck {
  const value = report.checks.find(({ checkId }) => checkId === id);
  expect(value, `missing ${id} result`).toBeDefined();
  return value!;
}

const FAST_CONFIG = `${JSON.stringify(
  {
    schemaVersion: 1,
    profile: "fast",
    checks: {
      secrets: "off",
      cyclomaticComplexity: { max: 1, blockWorsening: true },
      readabilityComplexity: { max: 1, blockWorsening: true },
    },
  },
  null,
  2,
)}\n`;

describe.sequential("packaged managed local suite", () => {
  it("isolates existing JS debt, detects worsened complexity and structural security, and never loads project ESLint config", async () => {
    const repository = await installedRepository();
    await repository.write(".zedbeerc.jsonc", FAST_CONFIG);
    await repository.write(
      "src/index.js",
      [
        'eval("1 + 1");',
        "export function decide(first, second) {",
        "  return first && second;",
        "}",
        "",
      ].join("\n"),
    );
    await repository.commitAll("existing debt");
    await repository.write(
      "src/index.js",
      [
        'eval("1 + 1");',
        "export function decide(first, second) {",
        "  if (first) {",
        "    if (second) return true;",
        "  }",
        "  return false;",
        "}",
        "const unused = 1;",
        "",
      ].join("\n"),
    );
    await repository.git(["add", "--", "src/index.js"]);

    const complexity = await runZedbee(repository.root);
    expect(complexity.result.exitCode, JSON.stringify(complexity.report)).toBe(
      1,
    );
    expect(complexity.report.outcome).toBe("blocked");
    expect(check(complexity.report, "structuralSecurity").findings).toEqual([]);
    expect(check(complexity.report, "lint").findings).toContainEqual(
      expect.objectContaining({
        rule: "no-unused-vars",
        location: expect.objectContaining({
          file: "src/index.js",
          startLine: 8,
        }),
      }),
    );
    for (const id of ["cyclomaticComplexity", "readabilityComplexity"]) {
      expect(check(complexity.report, id).findings).toEqual([
        expect.objectContaining({
          attribution: expect.objectContaining({
            staged: true,
            evidence: expect.arrayContaining([
              expect.stringContaining("src/index.js"),
            ]),
          }),
        }),
      ]);
    }
    expect(
      await access(join(repository.root, "CONFIG_EXECUTED")).catch(() => false),
    ).toBe(false);

    await repository.write(
      "src/index.js",
      `${await repository.read("src/index.js")}eval("2 + 2");\n`,
    );
    await repository.git(["add", "--", "src/index.js"]);
    const structural = await runZedbee(repository.root);
    expect(structural.result.exitCode).toBe(1);
    expect(check(structural.report, "structuralSecurity").findings).toEqual([
      expect.objectContaining({
        rule: "direct-eval",
        location: expect.objectContaining({
          file: "src/index.js",
          startLine: 9,
        }),
      }),
    ]);
  }, 45_000);

  it("reports a staged TypeScript diagnostic with machine evidence", async () => {
    const repository = await installedRepository();
    await repository.write(
      ".zedbeerc.jsonc",
      FAST_CONFIG.replace('"fast"', '"recommended"').replace(
        '"max": 1',
        '"max": 20',
      ),
    );
    await repository.write(
      "tsconfig.json",
      '{"compilerOptions":{"strict":true,"target":"ES2022"},"include":["src"]}\n',
    );
    await repository.write(
      "src/value.ts",
      'export const value: string = "ok";\n',
    );
    await repository.commitAll("typed baseline");
    await repository.write(
      "src/value.ts",
      "export const value: string = 42;\n",
    );
    await repository.git(["add", "--", "src/value.ts"]);

    const { result, report } = await runZedbee(repository.root);
    expect(result.exitCode, JSON.stringify(report)).toBe(1);
    expect(check(report, "types").findings).toEqual([
      expect.objectContaining({
        rule: "typescript/TS2322",
        location: expect.objectContaining({
          file: "src/value.ts",
          startLine: 1,
        }),
        attribution: expect.objectContaining({
          staged: true,
          evidence: expect.arrayContaining([expect.any(String)]),
        }),
      }),
    ]);
  }, 45_000);

  it("runs React DOM accessibility only when a browser renderer is present", async () => {
    const repository = await installedRepository({
      react: "19.2.0",
      "react-dom": "19.2.0",
    });
    await repository.write(".zedbeerc.jsonc", FAST_CONFIG);
    await repository.commitAll("react dom baseline");
    await repository.write(
      "src/app.jsx",
      'export function App() {\n  return <img src="/avatar.png" />;\n}\n',
    );
    await repository.git(["add", "--", "src/app.jsx"]);

    const { result, report } = await runZedbee(repository.root);
    expect(result.exitCode).toBe(1);
    expect(check(report, "reactCorrectness").status).toBe("completed");
    expect(check(report, "reactAccessibility").findings).toContainEqual(
      expect.objectContaining({
        rule: "jsx-a11y/alt-text",
        location: expect.objectContaining({ file: "src/app.jsx" }),
      }),
    );
  }, 45_000);

  it("runs React correctness for Ink without applying DOM accessibility", async () => {
    const repository = await installedRepository({
      ink: "7.1.1",
      react: "19.2.0",
    });
    await repository.write(".zedbeerc.jsonc", FAST_CONFIG);
    await repository.commitAll("ink baseline");
    await repository.write(
      "src/app.jsx",
      [
        'const Box = "box";',
        'const Text = "text";',
        'const items = ["one", "two"];',
        "export function App() {",
        "  return <Box>{items.map((item) => <Text>{item}</Text>)}</Box>;",
        "}",
        "",
      ].join("\n"),
    );
    await repository.git(["add", "--", "src/app.jsx"]);

    const { result, report } = await runZedbee(repository.root);
    expect(result.exitCode).toBe(1);
    expect(check(report, "reactCorrectness").findings).toContainEqual(
      expect.objectContaining({ rule: "react/jsx-key" }),
    );
    expect(check(report, "reactAccessibility")).toMatchObject({
      status: "skipped",
      skipReason: "No browser DOM renderer detected",
      findings: [],
    });
  }, 45_000);
});
