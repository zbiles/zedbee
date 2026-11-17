import { mkdtemp, rm } from "node:fs/promises";
import {
  acquireServiceExecutor,
  stopService,
} from "../../src/service/client.js";
import { expect, it, onTestFinished } from "vitest";
import { CHECK_IDS } from "../../src/config/schema.js";
import { runScan } from "../../src/scan/run-scan.js";
import { ObservationCacheStore } from "../../src/cache/store.js";
import { createGitRepository } from "../helpers/git-repository.js";
import { join } from "node:path";

it.each(["local", "service"] as const)(
  "%s tracks staged HTML additions, retargets, and removal across cold/warm caches with contradictory live HTML",
  async (mode) => {
    const repo = await createGitRepository("zedbee-vite-entry-");
    await repo.write(
      "package.json",
      JSON.stringify({ name: "web", devDependencies: { vite: "7" } }),
    );
    await repo.write(
      ".zedbeerc.jsonc",
      JSON.stringify({
        schemaVersion: 1,
        checks: Object.fromEntries(
          CHECK_IDS.map((id) => [id, id === "deadCode" ? "error" : "off"]),
        ),
      }),
    );
    for (const name of ["first", "second", "orphan"])
      await repo.write(`src/${name}.ts`, `console.log('${name}');`);
    await repo.write("index.html", "<p>No application module yet</p>");
    await repo.commitAll("baseline");
    const directory = await mkdtemp("/private/tmp/zv-");
    const options = { directory, concurrency: 1 as const };
    const executor =
      mode === "service" ? await acquireServiceExecutor(options) : undefined;
    onTestFinished(async () => {
      await executor?.close();
      if (executor) await stopService(options);
      await rm(directory, { recursive: true, force: true });
    });
    const cache = new ObservationCacheStore({
      root: join(repo.root, ".zedbee/test-cache"),
    });
    const html = (name: string) =>
      `<script type=module src="/src/${name}.ts"></script>`;
    for (const name of ["first", "second", "none"] as const) {
      await repo.write(
        "index.html",
        name === "none" ? "<p>Removed module</p>" : html(name),
      );
      await repo.git(["add", "index.html"]);
      await repo.write("index.html", html("orphan"));
      for (const selectedCache of [false, cache, cache] as const) {
        const report = await runScan({
          repositoryRoot: repo.root,
          cache: selectedCache,
          ...(executor === undefined ? {} : { executor }),
        });
        expect(report.checks, JSON.stringify(report)).toEqual([
          expect.objectContaining({ checkId: "deadCode", status: "completed" }),
        ]);
        expect(
          report.summary.findings.some(
            (f) => f.location?.file === `src/${name}.ts`,
          ),
        ).toBe(false);
        expect(
          report.summary.findings.some(
            (f) => f.location?.file === "src/orphan.ts",
          ),
        ).toBe(false);
        expect(
          report.summary.findings.some(
            (f) => f.location?.file === "src/first.ts",
          ),
        ).toBe(name !== "first");
      }
      if (name === "first") {
        await repo.write("index.html", html("first"));
        await repo.commitAll("first application module");
      }
    }
    await repo.git(["rm", "index.html"]);
    const deleted = await runScan({
      repositoryRoot: repo.root,
      cache,
      ...(executor === undefined ? {} : { executor }),
    });
    expect(deleted.checks, JSON.stringify(deleted)).toEqual([
      expect.objectContaining({ checkId: "deadCode", status: "completed" }),
    ]);
    expect(
      deleted.summary.findings.some((f) => f.location?.file === "src/first.ts"),
    ).toBe(true);
  },
);
