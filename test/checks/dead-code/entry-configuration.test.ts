import { expect, it } from "vitest";
import { join } from "node:path";
import { createInspectionFixture } from "../../inspection/fixture.js";
import { inspectRepository } from "../../../src/inspection/inspect-repository.js";
import { resolveConfig } from "../../../src/config/profiles.js";
import { snapshotEntryPoints } from "../../../src/checks/dead-code/entry-configuration.js";
import {
  captureAnalysisSources,
  withAnalysisSourceCapture,
} from "../../../src/inspection/source-capture.js";

it("reads arbitrary selected policy paths from immutable captured bytes", async () => {
  const f = await createInspectionFixture();
  await f.writeJson("package.json", { name: "app" });
  await f.write("src/start.ts", "console.log(1);");
  const path = "policies/arbitrary.config.jsonc";
  const data = {
    schemaVersion: 1 as const,
    checks: { deadCode: { entryPoints: ["src/start.ts"] } },
  };
  await f.writeJson(path, data);
  const inspection = await inspectRepository(f.root);
  const config = resolveConfig(data, join(f.root, path));
  const capture = await captureAnalysisSources([
    { snapshotRoot: inspection.snapshotRoot, paths: [path] },
  ]);
  expect(capture).toBeDefined();
  try {
    await f.writeJson(path, {
      schemaVersion: 1,
      checks: { deadCode: { entryPoints: [] } },
    });
    await withAnalysisSourceCapture(capture!, async () => {
      expect(
        await snapshotEntryPoints(inspection, config, f.root, true),
      ).toEqual(["src/start.ts"]);
    });
  } finally {
    await capture?.close();
  }
});
