import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_DUPLICATION_SETTINGS,
  jscpdOptions,
} from "../../../src/checks/duplication/settings.js";
import { duplicationInputPaths } from "../../../src/checks/duplication/input-paths.js";
import { inspectManagedCheck } from "../../../src/checks/applicability.js";
import { resolveConfig } from "../../../src/config/profiles.js";
import { inspectRepository } from "../../../src/inspection/inspect-repository.js";
import { createInspectionFixture } from "../../inspection/fixture.js";

const body =
  "export function calculate(value) {\n" +
  Array.from({ length: 20 }, (_, i) => `const item${i} = value + ${i};\n`).join(
    "",
  ) +
  "return value;\n}\n";

describe("duplication effective inputs", () => {
  it.each(["root", "nested", "both"])(
    "pins explicit-file engine coverage with %s Git ignore files",
    async (mode) => {
      const fixture = await createInspectionFixture();
      await fixture.writeJson("package.json", { name: "synthetic" });
      const files = ["one.ts", "src/two.ts", "src/three.ts"];
      for (const path of files) await fixture.write(path, body);
      await fixture.write(
        ".gitignore",
        mode !== "nested" ? "one.ts\nsrc/two.ts\n" : "",
      );
      await fixture.write(
        "src/.gitignore",
        mode !== "root" ? "three.ts\n" : "",
      );
      const inspection = await inspectRepository(fixture.root);
      const output = join(inspection.snapshotRoot, "report");
      // Match the adapter's managed config and explicit-file invocation. In
      // particular, pin gitignore:true rather than relying on CLI defaults.
      await fixture.writeJson("managed-jscpd.json", {
        ...jscpdOptions(DEFAULT_DUPLICATION_SETTINGS),
        format: ["javascript", "jsx", "typescript", "tsx"],
        reporters: ["json"],
        output,
        threshold: 5,
        silent: true,
        gitignore: true,
        absolute: true,
      });
      const result = await execa(
        process.execPath,
        [
          fileURLToPath(import.meta.resolve("jscpd/run-jscpd.js")),
          "--config",
          join(inspection.snapshotRoot, "managed-jscpd.json"),
          ...files.map((path) => join(inspection.snapshotRoot, path)),
        ],
        {
          cwd: inspection.snapshotRoot,
          shell: false,
          reject: false,
          stdin: "ignore",
        },
      );
      expect([0, 1]).toContain(result.exitCode);
      const report = JSON.parse(
        await readFile(join(output, "jscpd-report.json"), "utf8"),
      ) as {
        statistics: { total: { sources: number } };
        duplicates: {
          firstFile: { name: string };
          secondFile: { name: string };
        }[];
      };
      const covered = [
        ...new Set(
          report.duplicates
            .flatMap(({ firstFile, secondFile }) => [
              firstFile.name,
              secondFile.name,
            ])
            .map((path) =>
              relative(inspection.snapshotRoot, path).replaceAll("\\", "/"),
            ),
        ),
      ].sort();
      expect(covered).toEqual([...files].sort());
      expect(report.statistics.total.sources).toBe(files.length);
      expect(
        await duplicationInputPaths(inspection, inspection.workspaces[0]!),
      ).toEqual(covered);
    },
  );

  it("schedules a source deletion that can change the duplication ratio", async () => {
    const baseline = await createInspectionFixture();
    const target = await createInspectionFixture();
    for (const fixture of [baseline, target]) {
      await fixture.writeJson("package.json", { name: "synthetic" });
      await fixture.write("remaining.ts", body);
    }
    await baseline.write("removed.ts", "export const value = 1;\n");
    const path = "removed.ts";
    const context = {
      repositoryRoot: target.root,
      baselineInspection: await inspectRepository(baseline.root),
      targetInspection: await inspectRepository(target.root),
      config: resolveConfig({ schemaVersion: 1, profile: "thorough" }),
      changeSet: {
        files: new Map([
          [path, { path, status: "deleted" as const, addedRanges: [] }],
        ]),
        isEmpty: false,
        containsAddedLine: () => false,
      },
    };
    expect(await inspectManagedCheck("duplication", context)).toMatchObject({
      applies: true,
    });
  });
});
