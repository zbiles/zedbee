import { expect, it } from "vitest";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execa } from "execa";
import { CHECK_IDS } from "../../src/config/schema.js";
import { runScan } from "../../src/scan/run-scan.js";
import {
  acquireServiceExecutor,
  stopService,
} from "../../src/service/client.js";
import { ObservationCacheStore } from "../../src/cache/store.js";
import { createGitRepository } from "../helpers/git-repository.js";

it("compares identical worktrees using their own installation through one service", async () => {
  const repo = await createGitRepository("zedbee-install-worktree-");
  await repo.write(
    "package.json",
    JSON.stringify({ name: "fixture", dependencies: { react: "19.0.0" } }),
  );
  await repo.write(
    "tsconfig.json",
    JSON.stringify({
      compilerOptions: { strict: true, jsx: "react-jsx", types: [] },
      include: ["src"],
    }),
  );
  await repo.write(
    ".zedbeerc.jsonc",
    JSON.stringify({
      schemaVersion: 1,
      checks: Object.fromEntries(
        CHECK_IDS.map((id) => [id, id === "types" ? "error" : "off"]),
      ),
    }),
  );
  await repo.write("src/value.tsx", "export const value = 1;\n");
  await repo.commitAll("baseline");
  const scratch = await realpath(await mkdtemp(join(tmpdir(), "zi-")));
  const other = join(scratch, "w");
  expect(
    (await repo.git(["worktree", "add", "--detach", other, "HEAD"]))
      .exitCode,
  ).toBe(0);
  for (const root of [repo.root, other]) {
    await writeFile(
      join(root, "src/value.tsx"),
      "export const value = <div />;\n",
    );
    await execa("git", ["add", "src/value.tsx"], { cwd: root });
  }
  await repo.write(
    "node_modules/react/package.json",
    JSON.stringify({ name: "react", version: "19.0.0" }),
  );
  await repo.write(
    "node_modules/react/jsx-runtime.d.ts",
    "export namespace JSX { interface IntrinsicElements { div: {}; } }\nexport function jsx(...args: unknown[]): unknown;\n",
  );
  const options = {
    directory: join(scratch, "s"),
    concurrency: 1 as const,
  };
  const executor = await acquireServiceExecutor(options);
  const cache = new ObservationCacheStore({ root: join(scratch, "cache") });
  try {
    for (const selectedCache of [false, cache, cache] as const)
      for (const order of [
        [repo.root, other],
        [other, repo.root],
      ])
        for (const root of order) {
          const report = await runScan({
            repositoryRoot: root,
            executor,
            cache: selectedCache,
          });
          expect(report.outcome, JSON.stringify(report)).toBe(
            root === repo.root ? "pass" : "incomplete",
          );
          expect(
            report.summary.findings.filter(
              (f) => f.rule === "typescript/TS2875" && f.attribution.staged,
            ),
          ).toEqual([]);
        }
  } finally {
    await executor.close();
    await stopService(options);
    await repo.git(["worktree", "remove", "--force", other]);
    await rm(scratch, { recursive: true, force: true });
  }
});

it.each(["local", "service"] as const)(
  "%s completes a linked worktree upgrade with verified installations across cold and warm caches",
  async (mode) => {
    const repo = await createGitRepository("zedbee-upgrade-worktree-");
    const manifest = {
      name: "fixture",
      version: "1.0.0",
      devDependencies: { "@types/node": "26.0.0", zedbee: "0.1.0-beta.17" },
    };
    await repo.write(".gitignore", "node_modules/\n");
    await repo.write("package.json", JSON.stringify(manifest));
    await repo.write(
      "tsconfig.json",
      JSON.stringify({
        compilerOptions: { strict: true, noEmit: true },
        include: ["src"],
      }),
    );
    await repo.write(
      "src/value.ts",
      "export const value = process.version;\n",
    );
    await repo.write(
      ".zedbeerc.jsonc",
      JSON.stringify({
        schemaVersion: 1,
        checks: Object.fromEntries(
          CHECK_IDS.map((id) => [
            id,
            ["types", "lint"].includes(id) ? "error" : "off",
          ]),
        ),
      }),
    );
    await repo.commitAll("before upgrade");
    const scratch = await realpath(await mkdtemp(join(tmpdir(), "zu-")));
    const other = join(scratch, "w");
    await repo.git(["worktree", "add", "--detach", other, "HEAD"]);
    await writeFile(
      join(other, "package.json"),
      JSON.stringify({
        ...manifest,
        devDependencies: {
          ...manifest.devDependencies,
          zedbee: "0.1.0-beta.18",
        },
      }),
    );
    await execa("git", ["add", "package.json"], { cwd: other });
    const { mkdir } = await import("node:fs/promises");
    const install = async () => {
      await mkdir(join(other, "node_modules/@types/node"), {
        recursive: true,
      });
      await writeFile(
        join(other, "node_modules/@types/node/package.json"),
        JSON.stringify({
          name: "@types/node",
          version: "26.0.0",
          types: "index.d.ts",
        }),
      );
      await writeFile(
        join(other, "node_modules/@types/node/index.d.ts"),
        "declare const process: { version: string };\n",
      );
    };
    await install();
    const options = {
      directory: join(scratch, "s"),
      concurrency: 1 as const,
    };
    const executor =
      mode === "service"
        ? await acquireServiceExecutor(options)
        : undefined;
    const cache = new ObservationCacheStore({
      root: join(scratch, "cache"),
    });
    try {
      for (const selectedCache of [false, cache, cache] as const) {
        const report = await runScan({
          repositoryRoot: other,
          cache: selectedCache,
          ...(executor ? { executor } : {}),
        });
        expect(report.outcome, JSON.stringify(report)).toBe("pass");
        expect(report.checks).toHaveLength(2);
        expect(
          report.checks.every(
            (check) =>
              check.status === "completed" &&
              check.comparisonContext?.status === "comparable",
          ),
        ).toBe(true);
      }
      await rm(join(other, "node_modules/@types/node"), {
        recursive: true,
      });
      const partial = await runScan({
        repositoryRoot: other,
        cache,
        ...(executor ? { executor } : {}),
      });
      expect(partial.outcome).toBe("incomplete");
      expect(
        partial.checks.every(
          (check) =>
            check.error?.code === "COMPARISON_INSTALLATION_UNAVAILABLE",
        ),
      ).toBe(true);
      await install();
      expect(
        (
          await runScan({
            repositoryRoot: other,
            cache,
            ...(executor ? { executor } : {}),
          })
        ).outcome,
      ).toBe("pass");
    } finally {
      await executor?.close();
      if (executor) await stopService(options);
      await repo.git(["worktree", "remove", "--force", other]);
      await rm(scratch, { recursive: true, force: true });
    }
  },
);
