import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CHECK_IDS } from "../../src/config/schema.js";
import { ObservationCacheStore } from "../../src/cache/store.js";
import { runScan } from "../../src/scan/run-scan.js";
import type { ScanReport } from "../../src/scan/report.js";
import { createGitRepository } from "../helpers/git-repository.js";

/** Preserve complete findings and attribution; only presentation/time is volatile. */
export function scanDecision(report: ScanReport) {
  return {
    mode: report.mode,
    baseline: report.baseline,
    target: report.target,
    changedFileCount: report.changedFileCount,
    checks: report.checks.map(({ durationMs: _duration, ...check }) => check),
    outcome: report.outcome,
    exitCode: report.exitCode,
  };
}

describe("snapshot preparation attribution oracle", () => {
  it.each([false, "cold", "warm"] as const)(
    "suppresses moved existing debt but blocks a newly broken unchanged consumer (%s cache)",
    async (mode) => {
      const repo = await createGitRepository("zedbee-preparation-parity-");
      await repo.write("package.json", '{"name":"parity","private":true}');
      await repo.write(
        "tsconfig.json",
        JSON.stringify({
          compilerOptions: {
            strict: true,
            types: [],
            resolveJsonModule: true,
            esModuleInterop: true,
          },
          include: ["*.ts"],
        }),
      );
      await repo.write(
        ".zedbeerc.jsonc",
        JSON.stringify({
          schemaVersion: 1,
          profile: "recommended",
          checks: Object.fromEntries(
            CHECK_IDS.map((id) => [id, id === "types" ? "error" : "off"]),
          ),
        }),
      );
      await repo.write("data.json", '{"value":1}');
      await repo.write(
        "consumer.ts",
        'import data from "./data.json";\nexport const value: number = data.value;\n',
      );
      await repo.write("debt.ts", 'export const debt: number = "old";\n');
      await repo.commitAll("existing debt");
      const cache: false | ObservationCacheStore =
        mode === false
          ? false
          : new ObservationCacheStore({ root: join(repo.root, ".test-cache") });
      await repo.write("debt.ts", '\n\nexport const debt: number = "old";\n');
      await repo.git(["add", "debt.ts"]);
      const options = {
        repositoryRoot: repo.root,
        cache,
        sourceExcerpts: "exclude" as const,
      };
      const safe = await runScan(options);
      expect(safe.outcome, JSON.stringify(safe)).toBe("pass");
      expect(
        safe.checks.some(
          (check) => check.checkId === "types" && check.status === "completed",
        ),
      ).toBe(true);
      if (mode === "warm")
        expect(scanDecision(await runScan(options))).toEqual(
          scanDecision(safe),
        );
      await repo.write("data.json", '{"value":"new break"}');
      await repo.git(["add", "data.json"]);
      const broken = await runScan(options);
      expect(broken.outcome, JSON.stringify(broken)).toBe("blocked");
      expect(broken.summary.findings).toContainEqual(
        expect.objectContaining({
          check: "types",
          rule: "typescript/TS2322",
          location: expect.objectContaining({ file: "consumer.ts" }),
          attribution: expect.objectContaining({ staged: true }),
        }),
      );
      expect(
        broken.summary.findings.every(
          (finding) => finding.location?.file !== "debt.ts",
        ),
      ).toBe(true);
      if (mode === "warm")
        expect(scanDecision(await runScan(options))).toEqual(
          scanDecision(broken),
        );
    },
  );
});
