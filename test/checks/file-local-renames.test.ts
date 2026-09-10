import { describe, expect, it } from "vitest";
import type { CheckRunContext } from "../../src/checks/adapter.js";
import { complexityAdapters } from "../../src/checks/complexity/adapter.js";
import { structuralSecurityAdapter } from "../../src/checks/structural-security/adapter.js";
import { resolveConfig } from "../../src/config/profiles.js";
import type { CheckId } from "../../src/config/schema.js";
import type { ChangeSet } from "../../src/git/change-set.js";
import { inspectRepository } from "../../src/inspection/inspect-repository.js";
import { testFilePolicyResolver } from "../helpers/file-policy.js";
import { createInspectionFixture } from "../inspection/fixture.js";

const existing =
  "export function existing(input: string) { if (input) return eval(input); return 0; }\n";
const added =
  "export function added(input: string) { if (input) return eval(input); return 0; }\n";

describe.each(["existing", "new"] as const)(
  "file-local rename into a destination project that is %s",
  (destination) => {
    it.each([structuralSecurityAdapter, ...complexityAdapters])(
      "$id retains the old file baseline and excludes changes owned by another target",
      async (adapter) => {
        const [baseline, target] = await Promise.all([
          createInspectionFixture(),
          createInspectionFixture(),
        ]);
        for (const fixture of [baseline, target]) {
          await fixture.writeJson("legacy/package.json", {
            name: "legacy",
            private: true,
          });
          await fixture.writeJson("third/package.json", {
            name: "third",
            private: true,
          });
          await fixture.write("third/value.ts", existing);
        }
        if (destination === "existing") {
          await baseline.writeJson("dest/package.json", {
            name: "dest",
            private: true,
          });
          await baseline.write("dest/untouched.ts", existing);
          await target.write("dest/untouched.ts", existing);
        }
        await target.writeJson("dest/package.json", {
          name: "dest",
          private: true,
        });
        await baseline.write("legacy/value.ts", existing);
        await target.write("dest/value.ts", existing + added);
        await target.write("third/value.ts", existing + added);

        const changeSet: ChangeSet = {
          files: new Map([
            [
              "dest/value.ts",
              {
                path: "dest/value.ts",
                previousPath: "legacy/value.ts",
                status: "renamed",
                addedRanges: [{ start: 2, end: 2 }],
              },
            ],
            [
              "third/value.ts",
              {
                path: "third/value.ts",
                status: "modified",
                addedRanges: [{ start: 2, end: 2 }],
              },
            ],
          ]),
          isEmpty: false,
          containsAddedLine: (file, line) =>
            (file === "dest/value.ts" || file === "third/value.ts") &&
            line === 2,
        };
        const config = resolveConfig({
          schemaVersion: 1,
          profile: "recommended",
        });
        const context: CheckRunContext = {
          repositoryRoot: target.root,
          changeSet,
          config,
          snapshots: {
            baselineDir: baseline.root,
            targetDir: target.root,
            baselineRef: "HEAD",
            targetRef: "index",
            unsupportedEntries: [],
          },
          baselineInspection: await inspectRepository(baseline.root),
          targetInspection: await inspectRepository(target.root),
          target: { id: "dest", kind: "workspace", relativeRoot: "dest" },
          policy: config.checks[adapter.id as CheckId],
          policyForFile: testFilePolicyResolver(config, changeSet),
          signal: new AbortController().signal,
        };

        const collected = await adapter.collect(context);

        expect(collected.baselineObservations).toHaveLength(1);
        expect(
          collected.baselineObservations.map(
            ({ location, entity }) => location?.file ?? entity?.file,
          ),
        ).toEqual(["legacy/value.ts"]);
        expect(collected.targetObservations).toHaveLength(2);
        expect(
          collected.targetObservations.map(
            ({ location, entity }) => location?.file ?? entity?.file,
          ),
        ).toEqual(["dest/value.ts", "dest/value.ts"]);
      },
    );
  },
);
