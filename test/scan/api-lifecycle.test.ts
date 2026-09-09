import { expect, it } from "vitest";
import * as api from "../../src/index.js";
import { CHECK_IDS } from "../../src/config/schema.js";
import { createGitRepository } from "../helpers/git-repository.js";

it("reuses the experimental API executor across more than 64 real workspace jobs and fresh scans", async () => {
  expect(api).toHaveProperty("createLocalAnalyzerExecutor");
  const repository = await createGitRepository("zedbee-api-workspaces-");
  await repository.write(
    "package.json",
    JSON.stringify({
      name: "fixture",
      private: true,
      workspaces: ["packages/*"],
    }),
  );
  await repository.write(
    ".zedbeerc.jsonc",
    JSON.stringify({
      schemaVersion: 1,
      profile: "fast",
      checks: Object.fromEntries(
        CHECK_IDS.map((id) => [
          id,
          id === "structuralSecurity" ? "error" : "off",
        ]),
      ),
    }),
  );
  for (let i = 0; i < 70; i++) {
    await repository.write(
      `packages/p${i}/package.json`,
      JSON.stringify({ name: `p${i}`, private: true }),
    );
    await repository.write(
      `packages/p${i}/value.js`,
      "export const value = 1;\n",
    );
  }
  await repository.commitAll("baseline");
  for (let i = 0; i < 70; i++)
    await repository.write(
      `packages/p${i}/value.js`,
      "export const value = 2;\n",
    );
  await repository.git(["add", "--all"]);
  const executor = api.createLocalAnalyzerExecutor({ concurrency: 4 });
  try {
    const first = await api.runScan({
      repositoryRoot: repository.root,
      executor,
      cache: false,
    });
    expect(first.summary.incomplete).toBe(0);
    expect(
      first.checks.filter((check) => check.status === "completed").length,
    ).toBeGreaterThan(64);
    await repository.write(
      "packages/p0/value.js",
      'export const value = eval("2");\n',
    );
    await repository.git(["add", "--all"]);
    const second = await api.runScan({
      repositoryRoot: repository.root,
      executor,
      cache: false,
    });
    expect(second.summary.incomplete).toBe(0);
    expect(
      second.summary.findings.some(
        (finding) => finding.location?.file === "packages/p0/value.js",
      ),
    ).toBe(true);
    const next = await executor.openSession();
    await next.close();
  } finally {
    await executor.close();
  }
});
