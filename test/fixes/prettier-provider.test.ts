import { describe, expect, it } from "vitest";
import type { CheckRunContext, CheckTarget } from "../../src/checks/adapter.js";
import {
  formatWorkingSource,
  planPrettierFixes,
} from "../../src/fixes/prettier-provider.js";
import { resolveConfig } from "../../src/config/profiles.js";
import type { Finding } from "../../src/core/types.js";
import type { ChangeSet, ChangedFile } from "../../src/git/change-set.js";
import { testFilePolicyResolver } from "../helpers/file-policy.js";

const target: CheckTarget = { id: ".", kind: "repository", relativeRoot: "." };

function changeSet(files: readonly ChangedFile[]): ChangeSet {
  const changed = new Map(files.map((file) => [file.path, file]));
  return {
    files: changed,
    isEmpty: changed.size === 0,
    containsAddedLine(file, line) {
      return (
        changed
          .get(file)
          ?.addedRanges.some(
            (range) => line >= range.start && line <= range.end,
          ) ?? false
      );
    },
  };
}

function context(): CheckRunContext {
  const changes = changeSet([]);
  const config = resolveConfig({
    schemaVersion: 1,
    profile: "recommended",
    checks: {
      formatting: { settings: { printWidth: 100, semi: false } },
    },
    overrides: [
      {
        files: ["test/**"],
        checks: { formatting: { settings: { semi: true } } },
      },
      {
        files: ["generated/**"],
        checks: { formatting: "off" },
      },
    ],
  });
  const inspection = {
    snapshotRoot: "/tmp/target",
    packageManager: "unknown" as const,
    lockfiles: [],
    workspaces: [],
  };
  return {
    repositoryRoot: "/repo",
    changeSet: changes,
    config,
    snapshots: {
      baselineDir: "/tmp/baseline",
      targetDir: "/tmp/target",
      baselineRef: "HEAD",
      unsupportedEntries: [],
    },
    baselineInspection: { ...inspection, snapshotRoot: "/tmp/baseline" },
    targetInspection: inspection,
    target,
    policy: config.checks.formatting,
    policyForFile: testFilePolicyResolver(config, changes),
    signal: new AbortController().signal,
  };
}

function finding(
  id: string,
  file: string,
  severity: "warning" | "error" = "error",
): Finding {
  return {
    id,
    check: "formatting",
    rule: "prettier",
    severity,
    message: "Staged code does not match Zedbee's managed Prettier format.",
    location: { file, startLine: 1, endLine: 1 },
    attribution: { kind: "transformation-diff", staged: true, evidence: [] },
  };
}

describe("planPrettierFixes", () => {
  it("plans sorted correlated candidates from target-side managed settings", () => {
    const run = context();
    const policyCalls: string[] = [];
    const candidates = planPrettierFixes(
      {
        ...run,
        policyForFile(checkId, file, side) {
          policyCalls.push(`${checkId}:${file}:${side}`);
          return run.policyForFile(checkId, file, side);
        },
      },
      [
        finding("test-finding", "test/value.ts", "warning"),
        finding("zeta", "src/value.ts"),
        finding("ignored-unsupported", "notes/value.txt"),
        finding("alpha", "src/value.ts", "warning"),
        finding("ignored-off", "generated/value.ts"),
      ],
    );

    expect(candidates).toEqual([
      expect.objectContaining({
        kind: "format-file",
        checkId: "formatting",
        file: "src/value.ts",
        findingIds: ["alpha", "zeta"],
        severities: ["warning", "error"],
        settings: expect.objectContaining({ printWidth: 100, semi: false }),
      }),
      expect.objectContaining({
        kind: "format-file",
        checkId: "formatting",
        file: "test/value.ts",
        findingIds: ["test-finding"],
        severities: ["warning"],
        settings: expect.objectContaining({ printWidth: 100, semi: true }),
      }),
    ]);
    expect(Object.isFrozen(candidates)).toBe(true);
    expect(Object.isFrozen(candidates[0]?.settings)).toBe(true);
    expect(policyCalls).toEqual([
      "formatting:generated/value.ts:target",
      "formatting:notes/value.txt:target",
      "formatting:src/value.ts:target",
      "formatting:test/value.ts:target",
    ]);
  });
});

describe("formatWorkingSource", () => {
  it("formats the entire supplied working source with managed options", async () => {
    await expect(
      formatWorkingSource({
        file: "src/value.ts",
        source: "const existing={value:1}\nconst unstaged={value:2}\n",
        settings: {
          ...context().config.checks.formatting.settings,
          semi: false,
        },
      }),
    ).resolves.toBe(
      "const existing = { value: 1 }\nconst unstaged = { value: 2 }\n",
    );
  });
});
