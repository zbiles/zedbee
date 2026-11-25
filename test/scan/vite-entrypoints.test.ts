import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
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
    const directory = await realpath(await mkdtemp(join(tmpdir(), "zv-")));
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

it.each([".zedbeerc.jsonc", "policies/custom.jsonc"])(
  "validates policy-only entry changes through %s against each snapshot's own entries",
  async (path) => {
    const repo = await createGitRepository("zedbee-entry-policy-");
    await repo.write("package.json", JSON.stringify({ name: "app" }));
    const policy = (entries: readonly string[]) =>
      JSON.stringify({
        schemaVersion: 1,
        checks: Object.fromEntries(
          CHECK_IDS.map((id) => [
            id,
            id === "deadCode"
              ? { severity: "error", entryPoints: entries }
              : "off",
          ]),
        ),
      });
    await repo.write(path, policy(["src/first.ts"]));
    await repo.write("src/first.ts", "console.log('first');");
    await repo.write("src/second.ts", "console.log('second');");
    await repo.commitAll("baseline explicit entry");
    const options = {
      repositoryRoot: repo.root,
      cache: false as const,
      ...(path === ".zedbeerc.jsonc"
        ? {}
        : { configPath: join(repo.root, path) }),
    };
    await repo.write(path, policy(["src/missing.ts"]));
    await repo.git(["add", path]);
    const missing = await runScan(options);
    expect(missing.summary.incomplete, JSON.stringify(missing)).toBe(1);
    expect(missing.checks).toContainEqual(
      expect.objectContaining({ checkId: "deadCode", status: "incomplete" }),
    );
    for (const entries of [["src/second.ts"], []]) {
      await repo.write(path, policy(entries));
      await repo.git(["add", path]);
      const report = await runScan(options);
      expect(report.checks, JSON.stringify(report)).toEqual([
        expect.objectContaining({ checkId: "deadCode", status: "completed" }),
      ]);
      expect(report.summary.findings).toContainEqual(
        expect.objectContaining({
          rule: "files",
          location: expect.objectContaining({ file: "src/first.ts" }),
          attribution: expect.objectContaining({ staged: true }),
        }),
      );
    }
  },
);

it("reports unsupported baseline entry policy through the dead-code check boundary", async () => {
  const repo = await createGitRepository("zedbee-old-entry-policy-");
  await repo.write("package.json", '{"name":"app"}');
  await repo.write("src/start.ts", "console.log(1);");
  await repo.write(".zedbeerc.jsonc", "{invalid");
  await repo.commitAll("invalid old policy");
  await repo.write(
    ".zedbeerc.jsonc",
    JSON.stringify({
      schemaVersion: 1,
      checks: Object.fromEntries(
        CHECK_IDS.map((id) => [
          id,
          id === "deadCode"
            ? { severity: "error", entryPoints: ["src/start.ts"] }
            : "off",
        ]),
      ),
    }),
  );
  await repo.git(["add", ".zedbeerc.jsonc"]);
  const report = await runScan({ repositoryRoot: repo.root, cache: false });
  expect(report.summary.incomplete, JSON.stringify(report)).toBe(1);
  expect(report.checks).toContainEqual(
    expect.objectContaining({ checkId: "deadCode", status: "incomplete" }),
  );
});
