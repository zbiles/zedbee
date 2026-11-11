import { mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { createGitRepository } from "../helpers/git-repository.js";
import { runScan } from "../../src/scan/run-scan.js";
import { CHECK_IDS } from "../../src/config/schema.js";
import { persistProjectEslintTrust } from "../../src/checks/eslint/project/trust.js";

async function fixture(
  config = "export default [{rules:{'no-undef':'warn'}}];",
  trust = true,
) {
  const repo = await createGitRepository("swarm-project-eslint-");
  await repo.write(
    "package.json",
    JSON.stringify({
      name: "fixture",
      private: true,
      type: "module",
      devDependencies: { eslint: "9.39.5" },
    }),
  );
  await repo.write(
    "package-lock.json",
    JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "": { devDependencies: { eslint: "9.39.5" } },
        "node_modules/eslint": { version: "9.39.5" },
      },
    }),
  );
  await repo.write(".gitignore", "node_modules/\n");
  const checks = Object.fromEntries(
    CHECK_IDS.filter(
      (id) => !["reactCorrectness", "reactAccessibility"].includes(id),
    ).map((id) => [
      id,
      id === "lint" ? { engine: "project", severity: "error" } : "off",
    ]),
  );
  await repo.write(
    ".zedbeerc.jsonc",
    JSON.stringify({ schemaVersion: 1, profile: "recommended", checks }),
  );
  await repo.write("eslint.config.mjs", config);
  await repo.write("app.js", "export const value=1;\n");
  await repo.commitAll("baseline");
  await mkdir(join(repo.root, "node_modules"));
  await symlink(
    fileURLToPath(new URL("../../node_modules/eslint", import.meta.url)),
    join(repo.root, "node_modules/eslint"),
  );
  if (trust) await persistProjectEslintTrust(repo.root, ".", "execute");
  return repo;
}
const scan = async (repo: { root: string }) =>
  runScan({ repositoryRoot: repo.root, cache: false, timeout: "30s" });
it("uses native rule warnings and staged source despite unstaged edits", async () => {
  const repo = await fixture();
  await repo.write("app.js", "missing();\n");
  await repo.git(["add", "app.js"]);
  await repo.write("app.js", "export const clean=1;\n");
  const report = await scan(repo);
  expect(report.outcome).toBe("pass");
  expect(report.summary.warnings).toBe(1);
  expect(report.summary.findings[0]).toMatchObject({
    rule: "no-undef",
    severity: "warning",
    message: "Project ESLint reported a diagnostic.",
  });
  expect(
    report.checks.find((c) => c.checkId === "lint")?.eslintAnalysis,
  ).toMatchObject({ version: "9.39.5", checkedFiles: 2 });
});
it("fails visibly without project trust", async () => {
  const repo = await fixture(undefined, false);
  await repo.write("app.js", "missing();\n");
  await repo.git(["add", "."]);
  const report = await scan(repo);
  expect(report.outcome).toBe("incomplete");
  expect(report.checks.find((c) => c.checkId === "lint")?.error?.code).toBe(
    "PROJECT_ESLINT_TRUST_REQUIRED",
  );
});
it("runs for Markdown changes that affect a local plugin", async () => {
  const repo = await fixture(
    "import {readFileSync} from 'node:fs'; const blocked=readFileSync(new URL('./policy.md',import.meta.url),'utf8').trim()==='blocked'; export default [{plugins:{local:{rules:{policy:{create(c){return {Program(n){if(blocked)c.report({node:n,message:'Policy violation'});}};}}}}},rules:{'local/policy':'error'}}];",
  );
  await repo.write("policy.md", "allowed");
  await repo.commitAll("plugin data");
  await repo.write("policy.md", "blocked");
  await repo.git(["add", "policy.md"]);
  const report = await scan(repo);
  expect(report.outcome, JSON.stringify(report.checks)).toBe("blocked");
  expect(report.summary.findings[0]?.rule).toBe("local/policy");
});
it("reports ignored-all coverage as skipped", async () => {
  const repo = await fixture("export default [{ignores:['**/*.{js,mjs}']}];");
  await repo.write("app.js", "missing();\n");
  await repo.git(["add", "app.js"]);
  const report = await scan(repo);
  expect(report.outcome).toBe("pass");
  expect(report.checks.find((c) => c.checkId === "lint")).toMatchObject({
    status: "skipped",
    eslintAnalysis: { checkedFiles: 0, ignoredFiles: 2 },
  });
});
it("marks a fatal parser result incomplete", async () => {
  const repo = await fixture();
  await repo.write("app.js", "export const = ;\n");
  await repo.git(["add", "app.js"]);
  const report = await scan(repo);
  expect(report.outcome).toBe("incomplete");
});
it("introduces a new flat configuration without requiring it in HEAD", async () => {
  const repo = await fixture();
  await repo.git(["rm", "eslint.config.mjs"]);
  await repo.commitAll("before adoption");
  await repo.write(
    "eslint.config.mjs",
    "export default [{rules:{'no-undef':'error'}}];",
  );
  await repo.write("app.js", "missing();\n");
  await repo.git(["add", "."]);
  const report = await scan(repo);
  expect(report.outcome, JSON.stringify(report.checks)).toBe("blocked");
  expect(
    report.checks.find((c) => c.checkId === "lint")?.eslintAnalysis?.baseline,
  ).toBe("new-coverage");
});
it("reports newly enabled project coverage when a flat config already exists", async () => {
  const repo = await fixture("export default [{rules:{'no-undef':'error'}}];");
  const config = JSON.parse(await repo.read(".zedbeerc.jsonc"));
  config.checks.lint = { engine: "managed", severity: "error" };
  await repo.write(".zedbeerc.jsonc", JSON.stringify(config));
  await repo.write("app.js", "missing();\n");
  await repo.commitAll("before project activation");
  config.checks.lint.engine = "project";
  await repo.write(".zedbeerc.jsonc", JSON.stringify(config));
  await repo.git(["add", ".zedbeerc.jsonc"]);
  const report = await scan(repo);
  expect(report.outcome).toBe("blocked");
  expect(
    report.checks.find((c) => c.checkId === "lint")?.eslintAnalysis?.baseline,
  ).toBe("new-coverage");
});
it("explains full-message redaction when separate permission is absent", async () => {
  const repo = await fixture();
  const config = JSON.parse(await repo.read(".zedbeerc.jsonc"));
  config.reporting = { projectEslintMessages: "full" };
  await repo.write(".zedbeerc.jsonc", JSON.stringify(config));
  await repo.write("app.js", "missing();\n");
  await repo.git(["add", "."]);
  const report = await scan(repo);
  expect(
    report.checks.find((c) => c.checkId === "lint")?.eslintAnalysis,
  ).toMatchObject({
    messages: "redacted",
    messageNotice: "permission-required",
  });
  const { renderText } = await import("../../src/renderers/text.js");
  expect(renderText(report, { width: 80, color: false })).toContain(
    "Full project ESLint messages were requested",
  );
});
it("reports files excluded by Swarm separately from ESLint ignores", async () => {
  const repo = await fixture();
  const config = JSON.parse(await repo.read(".zedbeerc.jsonc"));
  config.pathExclusions = [
    { files: ["app.js"], checks: ["lint"], reason: "Generated fixture" },
  ];
  await repo.write(".zedbeerc.jsonc", JSON.stringify(config));
  await repo.write("app.js", "missing();\n");
  await repo.git(["add", "."]);
  const report = await scan(repo);
  expect(report.outcome).toBe("pass");
  expect(
    report.checks.find((c) => c.checkId === "lint")?.eslintAnalysis,
  ).toMatchObject({ excludedFiles: 1, checkedFiles: 1 });
});
it("runs project rules for deletion-only data changes", async () => {
  const repo = await fixture(
    "import {existsSync} from 'node:fs';const missing=!existsSync(new URL('./policy.md',import.meta.url));export default [{plugins:{local:{rules:{policy:{create(c){return {Program(n){if(missing)c.report({node:n,message:'Missing policy'});}};}}}}},rules:{'local/policy':'error'}}];",
  );
  await repo.write("policy.md", "present");
  await repo.commitAll("baseline data");
  await repo.git(["rm", "policy.md"]);
  const report = await scan(repo);
  expect(report.outcome).toBe("blocked");
  expect(report.summary.findings.some((f) => f.rule === "local/policy")).toBe(
    true,
  );
});
it("bypasses persistent result caches for project engines", async () => {
  const repo = await fixture();
  await repo.write("app.js", "missing();\n");
  await repo.git(["add", "app.js"]);
  let reads = 0,
    writes = 0;
  const cache = {
    get: async () => {
      reads++;
      return undefined;
    },
    set: async () => {
      writes++;
    },
  };
  const first = await runScan({ repositoryRoot: repo.root, cache });
  expect(first.summary.warnings).toBe(1);
  await repo.write(
    "eslint.config.mjs",
    "export default [{rules:{'no-undef':'error'}}];",
  );
  await repo.git(["add", "eslint.config.mjs"]);
  const second = await runScan({ repositoryRoot: repo.root, cache });
  expect(second.outcome).toBe("blocked");
  expect(reads).toBe(0);
  expect(writes).toBe(0);
});
