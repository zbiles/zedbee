import { join } from "node:path";
import { ObservationCacheStore } from "../../src/cache/store.js";
import { expect, it } from "vitest";
import { createGitRepository } from "../helpers/git-repository.js";
import { CHECK_IDS } from "../../src/config/schema.js";
import { runScan } from "../../src/scan/run-scan.js";
import { createLocalAnalyzerExecutor } from "../../src/checks/runner/executor.js";

it.each([1, 2, 4] as const)(
  "suppresses existing JSX runtime debt with partial retention (%i workers)",
  async (concurrency) => {
    const repo = await createGitRepository();
    await repo.write(
      ".zedbeerc.jsonc",
      JSON.stringify({
        schemaVersion: 1,
        checks: Object.fromEntries(
          CHECK_IDS.map((id) => [
            id,
            ["types", "lint"].includes(id)
              ? { severity: "error", when: "always" }
              : "off",
          ]),
        ),
      }),
    );
    for (const name of ["e2e", "extension", "web"]) {
      await repo.write(
        `${name}/package.json`,
        JSON.stringify({ name, private: true }),
      );
      await repo.write(
        `${name}/tsconfig.json`,
        JSON.stringify({
          compilerOptions: {
            strict: true,
            noEmit: true,
            jsx: "react-jsx",
            module: "esnext",
            moduleResolution: "bundler",
            types: [],
          },
          include: ["src"],
        }),
      );
      await repo.write(
        `${name}/src/App.tsx`,
        "const Icon = () => <svg><path /></svg>;\nexport function App() { return <div><Icon /></div>; }\n",
      );
      await repo.write(
        `${name}/src/padding.ts`,
        "/*" + "x".repeat(2 * 1024 * 1024) + "*/\nexport const padding = 1;\n",
      );
    }
    await repo.write("app.py", "value = 1\n");
    await repo.commitAll("baseline");
    await repo.write("app.py", "value = 2\n");
    await repo.git(["add", "app.py"]);
    const executor = createLocalAnalyzerExecutor({ concurrency });
    const cache = new ObservationCacheStore({
      root: join(repo.root, "observation-cache"),
    });
    try {
      for (const selectedCache of [false, cache, cache] as const) {
        const report = await runScan({
          repositoryRoot: repo.root,
          cache: selectedCache,
          executor,
        });
        expect(
          report.checks.filter((c) => c.status === "completed"),
        ).toHaveLength(6);
        expect(report.outcome, JSON.stringify(report.summary)).toBe("pass");
      }
      await repo.write(
        "extension/src/new-error.ts",
        'export const wrong: number = "wrong";\n',
      );
      await repo.git(["add", "extension/src/new-error.ts"]);
      for (const selectedCache of [false, cache, cache] as const) {
        const report = await runScan({
          repositoryRoot: repo.root,
          cache: selectedCache,
          executor,
        });
        expect(report.outcome).toBe("blocked");
        expect(report.summary.findings).toContainEqual(
          expect.objectContaining({ rule: "typescript/TS2322" }),
        );
      }
    } finally {
      await executor.close();
    }
  },
);
