import { cp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { runScan } from "../../../src/scan/run-scan.js";
import { executeChecksCommand } from "../../../src/commands/checks.js";
import { CHECK_IDS, type ConfigFile } from "../../../src/config/schema.js";
import { createGitRepository } from "../../helpers/git-repository.js";

const packageRoot = fileURLToPath(new URL("../../../", import.meta.url));

async function fixture(config: ConfigFile, plugin = false) {
  const repository = await createGitRepository("zedbee-project-dispatch-");
  await repository.write(
    "package.json",
    JSON.stringify({
      name: "fixture",
      devDependencies: { prettier: "3.9.6" },
    }),
  );
  await mkdir(join(repository.root, "node_modules"), { recursive: true });
  await cp(
    join(packageRoot, "node_modules/prettier"),
    join(repository.root, "node_modules/prettier"),
    { recursive: true },
  );
  await repository.write(".zedbeerc.jsonc", JSON.stringify(config));
  await repository.write(
    ".prettierrc.json",
    JSON.stringify({
      singleQuote: true,
      ...(plugin ? { plugins: ["./plugin.mjs"] } : {}),
    }),
  );
  if (plugin)
    await repository.write(
      "plugin.mjs",
      `
export const languages = [{ name: "Fixture", parsers: ["fixture"], extensions: [".fixturetxt"] }];
export const parsers = { fixture: { parse: text => text, astFormat: "fixture", locStart: () => 0, locEnd: text => text.length } };
export const printers = { fixture: { print: () => "FIXTURE\\n" } };
`,
    );
  return repository;
}

function policy(
  formatting: NonNullable<ConfigFile["checks"]>["formatting"],
  overrides?: ConfigFile["overrides"],
): ConfigFile {
  return {
    schemaVersion: 1,
    checks: {
      ...Object.fromEntries(CHECK_IDS.map((id) => [id, "off"])),
      formatting,
    },
    ...(overrides === undefined ? {} : { overrides }),
  };
}

async function describeFormatting(root: string) {
  const result = await executeChecksCommand(
    { cwd: root, format: "json", color: false },
    {
      stdoutIsTTY: false,
      width: 80,
      env: {},
      writeStdout: () => undefined,
      writeStderr: () => undefined,
    },
  );
  expect(result.exitCode).toBe(0);
  expect(
    result.checks.find((check) => check.id === "formatting")?.applicability,
  ).toBe("applicable");
}

it.each([
  ["mjs", false],
  ["fixturetxt", false],
  ["mjs", true],
  ["fixturetxt", true],
] as const)(
  "dispatches a sole changed .%s file with project override=%s",
  async (extension, scoped) => {
    const repository = await fixture(
      scoped
        ? policy("off", [
            {
              files: ["src/**"],
              checks: { formatting: { severity: "error", engine: "project" } },
            },
          ])
        : policy({ severity: "error", engine: "project" }),
      extension === "fixturetxt",
    );
    await repository.commitAll("configuration");
    const path = `src/value.${extension}`;
    await repository.write(
      path,
      extension === "mjs" ? 'export const value="changed";\n' : "unformatted\n",
    );
    await repository.git(["add", path]);
    await describeFormatting(repository.root);
    const report = await runScan({
      repositoryRoot: repository.root,
      projectPrettierTrust: true,
      cache: false,
    });
    expect(report.changedFileCount).toBe(1);
    const result = report.checks.find(
      (check) => check.checkId === "formatting",
    );
    expect(result?.status, JSON.stringify(result)).toBe("completed");
    expect(result?.findings.map((finding) => finding.location?.file)).toEqual([
      path,
    ]);
    expect(report.outcome).toBe("blocked");
  },
);

it.each([false, true])(
  "keeps disjoint formatting engines independent with reverse order=%s",
  async (reverse) => {
    const overrides: NonNullable<ConfigFile["overrides"]> = [
      {
        files: ["docs/**"],
        checks: {
          formatting: { engine: "managed", settings: { semi: false } },
        },
      },
      { files: ["src/**"], checks: { formatting: { engine: "project" } } },
    ];
    const repository = await fixture(
      policy(
        { severity: "error", engine: "managed" },
        reverse ? [...overrides].reverse() : overrides,
      ),
    );
    await repository.write("docs/value.ts", 'export const value = "old"\n');
    await repository.write("src/value.ts", "export const value = 'old';\n");
    await repository.commitAll("baseline");
    await repository.write("docs/value.ts", 'export const value = "changed"\n');
    await repository.write("src/value.ts", "export const value = 'changed';\n");
    await repository.git(["add", "docs/value.ts", "src/value.ts"]);
    await describeFormatting(repository.root);
    const report = await runScan({
      repositoryRoot: repository.root,
      projectPrettierTrust: true,
      cache: false,
    });
    expect(report.outcome, JSON.stringify(report.checks)).toBe("pass");
    expect(
      report.checks.find((check) => check.checkId === "formatting"),
    ).toMatchObject({ status: "completed", findings: [] });
  },
);

it("still rejects managed settings overlapping a project-engine file", async () => {
  const repository = await fixture(
    policy({ severity: "error", engine: "managed" }, [
      {
        files: ["src/**"],
        checks: { formatting: { settings: { semi: false } } },
      },
      { files: ["src/**"], checks: { formatting: { engine: "project" } } },
    ]),
  );
  await repository.commitAll("configuration");
  await repository.write("src/value.ts", "export const value=1;\n");
  await repository.git(["add", "src/value.ts"]);
  const report = await runScan({
    repositoryRoot: repository.root,
    projectPrettierTrust: true,
    cache: false,
  });
  expect(report.outcome).toBe("incomplete");
  expect(report.exitCode).toBe(2);
});

it("uses a replacement installed Prettier version on the next production scan", async () => {
  const repository = await fixture(
    policy({ severity: "error", engine: "project" }),
  );
  await repository.write(
    "package.json",
    JSON.stringify({
      name: "fixture",
      devDependencies: { prettier: "^3.0.0" },
    }),
  );
  await repository.commitAll("configuration");
  await repository.write("value.ts", 'export const value="changed";\n');
  await repository.git(["add", "value.ts"]);
  const scan = () =>
    runScan({ repositoryRoot: repository.root, projectPrettierTrust: true });
  const first = await scan();
  expect(
    first.checks.find((check) => check.checkId === "formatting")
      ?.formattingProvenance?.[0]?.version,
  ).toBe("3.9.6");
  const installation = join(repository.root, "node_modules/prettier");
  await rm(installation, { recursive: true });
  await cp(join(packageRoot, "node_modules/prettier-3-0-3"), installation, {
    recursive: true,
  });
  const second = await scan();
  expect(
    second.checks.find((check) => check.checkId === "formatting")
      ?.formattingProvenance?.[0]?.version,
  ).toBe("3.0.3");
  expect(second.outcome).toBe("blocked");
});

it("reloads an installed plugin implementation between production scans", async () => {
  const repository = await fixture(
    policy({ severity: "error", engine: "project" }),
    true,
  );
  const plugin = await repository.read("plugin.mjs");
  await repository.write(
    "node_modules/fixture-plugin/package.json",
    JSON.stringify({
      name: "fixture-plugin",
      version: "1.0.0",
      type: "module",
      main: "index.mjs",
    }),
  );
  await repository.write("node_modules/fixture-plugin/index.mjs", plugin);
  await repository.write(
    "package.json",
    JSON.stringify({
      name: "fixture",
      devDependencies: { prettier: "3.9.6", "fixture-plugin": "1.0.0" },
    }),
  );
  await repository.write(
    ".prettierrc.json",
    JSON.stringify({ plugins: ["fixture-plugin"] }),
  );
  await repository.commitAll("configuration");
  await repository.write("value.fixturetxt", "FIXTURE\n");
  await repository.git(["add", "value.fixturetxt"]);
  const scan = () =>
    runScan({ repositoryRoot: repository.root, projectPrettierTrust: true });
  const first = await scan();
  expect(first.outcome).toBe("pass");
  expect(
    first.checks.find((check) => check.checkId === "formatting")?.status,
  ).toBe("completed");
  await repository.write(
    "node_modules/fixture-plugin/index.mjs",
    plugin.replace("FIXTURE", "CHANGED"),
  );
  const second = await scan();
  expect(second.outcome).toBe("blocked");
  expect(
    second.checks
      .find((check) => check.checkId === "formatting")
      ?.findings.map((finding) => finding.location?.file),
  ).toEqual(["value.fixturetxt"]);
});
