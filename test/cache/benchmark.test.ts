import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CHECK_IDS } from "../../src/config/schema.js";
import { parseBenchmarkHistory } from "../../bench/report.mjs";

describe("performance baselines", () => {
  it("tracks every shipped adapter separately in every fixture", async () => {
    const history = parseBenchmarkHistory(
      await readFile(
        resolve(import.meta.dirname, "../../bench/README.md"),
        "utf8",
      ),
    );

    for (const baselines of history) {
      for (const fixture of ["small", "monorepo"]) {
        const phases = baselines.fixtures[fixture];
        expect(phases).toBeDefined();
      }
      const adapterPhases = baselines.fixtures.small;
      for (const checkId of CHECK_IDS) {
        expect(adapterPhases).toHaveProperty(`adapter.${checkId}.execute`);
      }
    }
  });
});
