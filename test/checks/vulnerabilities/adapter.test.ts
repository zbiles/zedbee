import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CheckRunContext } from "../../../src/checks/adapter.js";
import { observationCheckResult } from "../../../src/checks/observation-result.js";
import { createVulnerabilitiesAdapter } from "../../../src/checks/vulnerabilities/adapter.js";
import { resolveConfig } from "../../../src/config/profiles.js";
import type { ChangeSet } from "../../../src/git/change-set.js";
import type { ManagedBinary } from "../../../src/managed-binaries/types.js";
import { inspectRepository } from "../../../src/inspection/inspect-repository.js";
import { createInspectionFixture } from "../../inspection/fixture.js";

const binary: ManagedBinary = {
  engine: "osv-scanner",
  version: "2.4.0",
  platform: "darwin",
  arch: "arm64",
  packageName: "@zedbee/osv-scanner-darwin-arm64",
  packageRoot: "/managed",
  manifestPath: "/managed/manifest.json",
  executablePath: "/managed/osv-scanner",
  executableSha256: "0".repeat(64),
};

function osv(path: string, includeNew: boolean, version = "1.0.0"): string {
  return JSON.stringify({
    results: [
      {
        source: { path: `${path}/package-lock.json`, type: "lockfile" },
        packages: [
          {
            package: { name: "existing", version, ecosystem: "npm" },
            vulnerabilities: [{ id: "GHSA-existing" }],
          },
          ...(includeNew
            ? [
                {
                  package: {
                    name: "newly-vulnerable",
                    version: "2.0.0",
                    ecosystem: "npm",
                  },
                  vulnerabilities: [
                    { id: "GHSA-new", severity: [{ score: "9.1" }] },
                  ],
                },
              ]
            : []),
        ],
      },
    ],
  });
}

async function context(
  options: {
    changed?: boolean;
    when?: "relevant" | "always";
    network?: "online" | "offline";
  } = {},
): Promise<CheckRunContext> {
  const [baseline, target, live] = await Promise.all([
    createInspectionFixture(),
    createInspectionFixture(),
    createInspectionFixture(),
  ]);
  for (const fixture of [baseline, target, live]) {
    await fixture.writeJson("package.json", { name: "fixture" });
    await fixture.writeJson("package-lock.json", {
      name: "fixture",
      lockfileVersion: 3,
      packages: {},
    });
  }
  const changed = options.changed ?? true;
  const changeSet: ChangeSet = {
    files: new Map([
      [
        changed ? "package-lock.json" : "src/index.ts",
        {
          path: changed ? "package-lock.json" : "src/index.ts",
          status: "modified",
          addedRanges: [{ start: 1, end: 1 }],
        },
      ],
    ]),
    isEmpty: false,
    containsAddedLine: () => true,
  };
  const config = resolveConfig({
    schemaVersion: 1,
    profile: "thorough",
    checks: {
      vulnerabilities: {
        severity: "error",
        when: options.when ?? "relevant",
        network: options.network ?? "online",
      },
    },
  });
  return {
    repositoryRoot: live.root,
    changeSet,
    config,
    snapshots: {
      baselineDir: baseline.root,
      targetDir: target.root,
      baselineRef: "HEAD",
      unsupportedEntries: [],
    },
    baselineInspection: await inspectRepository(baseline.root),
    targetInspection: await inspectRepository(target.root),
    target: { id: ".", kind: "repository", relativeRoot: "." },
    policy: config.checks.vulnerabilities,
    signal: new AbortController().signal,
  };
}

describe("vulnerabilitiesAdapter", () => {
  it("skips unchanged dependency state unless configured to run always", async () => {
    const relevant = await context({ changed: false });
    const adapter = createVulnerabilitiesAdapter({
      resolveBinary: async () => binary,
      runBinary: async () => ({ stdout: "{}", stderr: "", exitCode: 0 }),
      offlineDatabasePath: () => undefined,
    });
    await expect(adapter.inspect(relevant)).resolves.toEqual({
      applies: false,
      reason: "No staged dependency state changes",
    });
    await expect(
      adapter.inspect(await context({ changed: false, when: "always" })),
    ).resolves.toMatchObject({ applies: true });
  });

  it("discloses online metadata and compares advisory/package state", async () => {
    const run = await context();
    const adapter = createVulnerabilitiesAdapter({
      resolveBinary: async () => binary,
      runBinary: async (_binary, args, options) => {
        expect(args).not.toContain("--offline");
        return {
          stdout: osv(
            options.cwd,
            options.cwd === run.snapshots.targetDir,
            options.cwd === run.snapshots.targetDir ? "1.0.1" : "1.0.0",
          ),
          stderr: "",
          exitCode: 1,
        };
      },
      offlineDatabasePath: () => undefined,
    });
    await expect(adapter.inspect(run)).resolves.toMatchObject({
      applies: true,
      executionClass: "network",
      networkDisclosure: {
        services: ["api.osv.dev", "api.deps.dev"],
        metadata: [
          "package names",
          "versions",
          "ecosystems",
          "supported file hashes",
        ],
      },
    });
    const set = await adapter.collect(run);
    const result = await observationCheckResult(
      "vulnerabilities",
      set,
      run,
      true,
    );
    expect(
      result.findings.filter(({ attribution }) => attribution.staged),
    ).toMatchObject([
      { rule: "GHSA-new", location: { file: "package-lock.json" } },
    ]);
    expect(
      result.findings.find(({ rule }) => rule === "GHSA-existing")?.attribution
        .staged,
    ).toBe(false);
  });

  it("uses a verified local database in strict offline mode", async () => {
    const run = await context({ network: "offline" });
    const database = await mkdtemp(join(tmpdir(), "zedbee-osv-db-"));
    await mkdir(join(database, "osv-scanner/npm"), { recursive: true });
    await writeFile(join(database, "osv-scanner/npm/all.zip"), "fixture");
    const canonicalDatabase = await realpath(database);
    let calls = 0;
    const adapter = createVulnerabilitiesAdapter({
      resolveBinary: async () => binary,
      runBinary: async (_binary, args, options) => {
        calls += 1;
        expect(args.slice(0, 4)).toEqual([
          "scan",
          "source",
          "--offline",
          "--offline-vulnerabilities",
        ]);
        expect(options.environment).toEqual({
          OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY: canonicalDatabase,
        });
        return { stdout: osv(options.cwd, false), stderr: "", exitCode: 1 };
      },
      offlineDatabasePath: () => database,
    });
    const applicability = await adapter.inspect(run);
    expect(applicability).toMatchObject({
      applies: true,
      executionClass: "project-analysis",
    });
    expect(applicability).not.toHaveProperty("networkDisclosure");
    await adapter.collect(run);
    expect(calls).toBe(2);
  });

  it("is incomplete when offline mode has no verified database", async () => {
    const run = await context({ network: "offline" });
    const adapter = createVulnerabilitiesAdapter({
      resolveBinary: async () => binary,
      runBinary: async () => {
        throw new Error("must not run");
      },
      offlineDatabasePath: () => undefined,
    });
    await expect(adapter.collect(run)).rejects.toThrow(
      "Vulnerability analysis failed.",
    );
  });
});
