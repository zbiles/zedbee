import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { CHECK_IDS } from "../../src/config/schema.js";
import { runScan } from "../../src/scan/run-scan.js";
import { ObservationCacheStore } from "../../src/cache/store.js";
import { createLocalAnalyzerExecutor } from "../../src/checks/runner/executor.js";
import type { ScanEvent } from "../../src/checks/events.js";
import { createGitRepository } from "../helpers/git-repository.js";

const token = `ghp_${"A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"}`;
async function fixture(existing: boolean, secrets = true) {
  const repo = await createGitRepository("zedbee-diagnostic-privacy-");
  await repo.write("package.json", '{"name":"privacy","type":"module"}\n');
  await repo.write(
    "tsconfig.json",
    JSON.stringify({
      compilerOptions: { strict: true, noEmit: true, types: [] },
      include: ["src/**/*.ts"],
    }),
  );
  await repo.write(
    ".zedbeerc.jsonc",
    JSON.stringify({
      schemaVersion: 1,
      profile: "recommended",
      checks: Object.fromEntries(
        CHECK_IDS.map((id) => [
          id,
          id === "types" || (id === "secrets" && secrets) ? "error" : "off",
        ]),
      ),
    }),
  );
  await repo.write(
    "src/value.ts",
    existing ? `export const credential = "${token}";\n` : "export {};\n",
  );
  await repo.commitAll("baseline");
  await repo.write(
    "src/value.ts",
    `export const credential: "safe" = "${token}";\n`,
  );
  expect((await repo.git(["add", "src/value.ts"])).exitCode).toBe(0);
  return repo;
}

async function scan(options: Parameters<typeof runScan>[0]) {
  const executor = createLocalAnalyzerExecutor();
  try {
    return await runScan({ ...options, executor });
  } finally {
    await executor.close();
  }
}

describe("diagnostic and existing-secret privacy", () => {
  it("omits context-dependent AWS credentials even when compiler prose lacks the assignment context", async () => {
    const repo = await fixture(false);
    const awsSecret = "aB3dE6gH9jK2mN5pQ8sT1vW4yZ7cF0iL3oR6uX9z";
    await repo.write(
      "src/value.ts",
      `const AWS_SECRET_ACCESS_KEY = "${awsSecret}";\nconst invalid: "expected" = AWS_SECRET_ACCESS_KEY;\n`,
    );
    expect((await repo.git(["add", "src/value.ts"])).exitCode).toBe(0);
    const events: ScanEvent[] = [];
    const report = await scan({
      repositoryRoot: repo.root,
      cache: false,
      sourceExcerpts: "exclude",
      onEvent: (event) => events.push(event),
    });
    expect(
      report.summary.findings.some(({ check }) => check === "secrets"),
    ).toBe(true);
    expect(report.summary.findings.some(({ check }) => check === "types")).toBe(
      true,
    );
    expect(JSON.stringify([report, events])).not.toContain(awsSecret);
  });
  it.each([true, false])(
    "masks TypeScript events, no-source reports, and persisted/warm cache with secrets enabled=%s",
    async (secrets) => {
      const repo = await fixture(false, secrets);
      const root = await mkdtemp(join(tmpdir(), "zedbee-diagnostic-cache-"));
      onTestFinished(() => rm(root, { recursive: true, force: true }));
      const cache = new ObservationCacheStore({ root });
      const events: ScanEvent[] = [];
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const report = await scan({
          repositoryRoot: repo.root,
          cache,
          sourceExcerpts: "exclude",
          onEvent: (event) => events.push(event),
        });
        expect(
          report.checks.find(({ checkId }) => checkId === "types")?.findings[0]
            ?.message,
        ).toContain("not assignable");
        expect(
          report.summary.findings.some(({ check }) => check === "secrets"),
        ).toBe(secrets);
        expect(JSON.stringify(report)).not.toContain(token);
      }
      expect(JSON.stringify(events)).not.toContain(token);
      const entries = (await readdir(root, { recursive: true })).filter(
        (file) => file.endsWith(".json"),
      );
      expect(entries.length).toBeGreaterThan(0);
      for (const file of entries)
        expect(await readFile(join(root, file), "utf8")).not.toContain(token);
    },
  );

  it.each(["index", "base"] as const)(
    "redacts baseline-matched secret lines before %s report excerpts",
    async (mode) => {
      const repo = await fixture(true);
      const baseRef = (await repo.git(["rev-parse", "HEAD"])).stdout.trim();
      if (mode === "base") await repo.commitAll("target");
      const report = await scan({
        repositoryRoot: repo.root,
        cache: false,
        reportingSurface: "json",
        sourceExcerpts: "include",
        ...(mode === "base" ? { baseRef } : {}),
      });
      expect(
        report.summary.findings.some(({ check }) => check === "secrets"),
      ).toBe(false);
      const diagnostic = report.summary.findings.find(
        ({ check }) => check === "types",
      );
      expect(diagnostic?.sourceExcerpt).toEqual({
        line: 1,
        redacted: true,
        truncated: false,
      });
      expect(JSON.stringify(report)).not.toContain(token);
    },
  );
});
