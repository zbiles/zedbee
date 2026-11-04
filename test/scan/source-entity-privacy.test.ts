import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { collectChangedEntities } from "../../src/attribution/entities.js";
import {
  ObservationCacheStore,
  sanitizeCacheableObservationSet,
} from "../../src/cache/store.js";
import { parseKnipReport } from "../../src/checks/dead-code/parse-report.js";
import { createLocalAnalyzerExecutor } from "../../src/checks/runner/executor.js";
import { CHECK_IDS } from "../../src/config/schema.js";
import { renderJson } from "../../src/renderers/json.js";
import { renderSarif } from "../../src/renderers/sarif.js";
import { runScan } from "../../src/scan/run-scan.js";
import { createGitRepository } from "../helpers/git-repository.js";

const token = `ghp_${"A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"}`;

describe("source-derived entity privacy", () => {
  it.each(["include", "exclude"] as const)(
    "omits method keys from %s-source reports, events and cold/warm caches above and below limits",
    async (sourceExcerpts) => {
      const repo = await createGitRepository("zedbee-entity-privacy-");
      await repo.write("package.json", '{"name":"privacy","type":"module"}\n');
      await repo.write("src/value.ts", "export {};\n");
      await repo.commitAll("baseline");
      await repo.write(
        "src/value.ts",
        `export const value = { "${token}"(ready: boolean) { if (ready) return 1; return 0; } };\n`,
      );
      const root = await mkdtemp(join(tmpdir(), "zedbee-entity-cache-"));
      onTestFinished(() => rm(root, { recursive: true, force: true }));
      const cache = new ObservationCacheStore({ root });
      for (const max of [1, 100]) {
        await repo.write(
          ".zedbeerc.jsonc",
          JSON.stringify({
            schemaVersion: 1,
            checks: Object.fromEntries(
              CHECK_IDS.map((id) => [
                id,
                id === "secrets"
                  ? "error"
                  : id === "cyclomaticComplexity"
                    ? { severity: "error", max }
                    : "off",
              ]),
            ),
          }),
        );
        expect((await repo.git(["add", "."])).exitCode).toBe(0);
        let hits = 0;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const executor = createLocalAnalyzerExecutor();
          const events: unknown[] = [];
          try {
            const report = await runScan({
              repositoryRoot: repo.root,
              sourceExcerpts,
              executor,
              cache: {
                set: (key, value) => cache.set(key, value),
                get: async (key) => {
                  const value = await cache.get(key);
                  if (value !== undefined) hits++;
                  return value;
                },
              },
              onEvent: (event) => events.push(event),
            });
            expect(
              report.checks.find(
                ({ checkId }) => checkId === "cyclomaticComplexity",
              )?.status,
            ).toBe("completed");
            expect(
              report.summary.findings.some(({ check }) => check === "secrets"),
            ).toBe(true);
            expect(
              report.summary.findings.some(
                ({ check }) => check === "cyclomaticComplexity",
              ),
            ).toBe(max === 1);
            expect(
              JSON.stringify([
                report,
                events,
                renderJson(report),
                renderSarif(report),
              ]),
            ).not.toContain(token);
          } finally {
            await executor.close();
          }
        }
        expect(hits).toBeGreaterThan(0);
        const entries = (await readdir(root)).filter((file) =>
          file.endsWith(".json"),
        );
        expect(entries.length).toBeGreaterThan(0);
        for (const file of entries)
          expect(await readFile(join(root, file), "utf8")).not.toContain(token);
      }
    },
  );

  it("protects quoted, escaped, identifier and lexical-owner names while retaining stable equality", () => {
    const forms = [
      `"${token}"`,
      `'${token}'`,
      `"\\u0067${token.slice(1)}"`,
      token,
    ];
    const identities = forms.map((key) =>
      collectChangedEntities(
        `export const value = { ${key}() { return 1; } };`,
        "src/value.ts",
        [{ start: 1, end: 1 }],
      ),
    );
    for (const entities of identities)
      expect(JSON.stringify(entities)).not.toContain(token);
    expect(
      identities.every(
        (entities) => entities[0]?.identity === identities[0]?.[0]?.identity,
      ),
    ).toBe(true);
    expect(
      JSON.stringify(
        collectChangedEntities(`class ${token} { run() {} }`, "src/value.ts", [
          { start: 1, end: 1 },
        ]),
      ),
    ).not.toContain(token);
  });

  it("makes Knip names opaque before cache persistence and preserves grouping without delimiter collisions", async () => {
    const observations = parseKnipReport(
      {
        issues: [
          {
            file: "src/value.ts",
            exports: [{ name: token }],
            duplicates: [
              [{ name: "a|b" }, { name: "c" }],
              [{ name: "a" }, { name: "b|c" }],
            ],
          },
        ],
      },
      new Set(["src/value.ts"]),
    );
    expect(observations).toHaveLength(3);
    expect(new Set(observations.map(({ identity }) => identity)).size).toBe(3);
    expect(JSON.stringify(observations)).not.toContain(token);
    const root = await mkdtemp(join(tmpdir(), "zedbee-knip-name-cache-"));
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    const cache = new ObservationCacheStore({ root });
    const value = {
      checkId: "deadCode",
      target: { id: ".", kind: "repository" as const, relativeRoot: "." },
      baselineObservations: [],
      targetObservations: observations,
      dependencyInputs: {
        version: 1 as const,
        roots: "a".repeat(64),
        probes: [],
      },
    };
    const key = "a".repeat(64);
    await cache.set(key, value);
    await expect(cache.get(key)).resolves.toEqual(value);
    expect(await readFile(join(root, `${key}.json`), "utf8")).not.toContain(
      token,
    );
  });

  it("rejects legacy source-bearing entities from custom caches", () => {
    expect(() =>
      sanitizeCacheableObservationSet({
        checkId: "cyclomaticComplexity",
        target: { id: ".", kind: "repository", relativeRoot: "." },
        baselineObservations: [],
        targetObservations: [
          {
            check: "cyclomaticComplexity",
            rule: "cyclomatic-complexity",
            identity: `function:src/value.ts:${token}`,
            entity: { kind: "function", name: token, file: "src/value.ts" },
            metric: { name: "cyclomatic-complexity", value: 1 },
            severity: "error",
            message: "Complexity metric.",
          },
        ],
      }),
    ).toThrow();
  });
});
