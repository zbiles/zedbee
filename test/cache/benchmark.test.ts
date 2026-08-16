import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CHECK_IDS } from "../../src/config/schema.js";

describe("performance baselines", () => {
  it("tracks every shipped adapter separately in every fixture", async () => {
    const baselines = JSON.parse(
      await readFile(
        resolve(import.meta.dirname, "../../bench/baselines.json"),
        "utf8",
      ),
    ) as {
      fixtures: Record<string, Record<string, unknown>>;
    };

    for (const fixture of ["small", "monorepo"]) {
      const phases = baselines.fixtures[fixture];
      expect(phases).toBeDefined();
    }
    const adapterPhases = baselines.fixtures.small;
    for (const checkId of CHECK_IDS) {
      expect(adapterPhases).toHaveProperty(`adapter.${checkId}.execute`);
    }
  });
});
