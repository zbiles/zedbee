import { expect, it } from "vitest";
import { createObservationCacheKey } from "../../src/cache/key.js";
import { observationCacheEngineIdentity } from "../../src/checks/engine-identity.js";
import { ObservationCacheStore } from "../../src/cache/store.js";
import { createInspectionFixture } from "../inspection/fixture.js";

it("does not reuse unpatched React observations for the corrected engine", async () => {
  const [baseline, target] = await Promise.all([
    createInspectionFixture(),
    createInspectionFixture(),
  ]);
  await baseline.write("example.tsx", "export const x = 1;\n");
  await target.write("example.tsx", "export const x = 2;\n");
  const identity = observationCacheEngineIdentity("reactCorrectness")!;
  expect(identity).toContain("effect-timing-v1");
  const oldIdentity = identity.replace(/\+effect-timing-v1:[a-f0-9]+/u, "");
  expect(oldIdentity).not.toBe(identity);
  const input = {
    checkId: "reactCorrectness" as const,
    policy: { severity: "error" as const, when: "relevant" as const },
    checkTarget: { id: ".", kind: "workspace" as const, relativeRoot: "." },
    baselineRoot: baseline.root,
    targetRoot: target.root,
    mode: "index" as const,
    baseline: "HEAD" as const,
    target: "index" as const,
    relevantConfig: {},
    zedbeeVersion: "0.1.0-beta.15",
  };
  const oldKey = await createObservationCacheKey({
    ...input,
    engineIdentity: oldIdentity,
  });
  const newKey = await createObservationCacheKey({
    ...input,
    engineIdentity: identity,
  });
  const store = new ObservationCacheStore({ root: target.root + "/cache" });
  await store.set(oldKey, {
    checkId: "reactCorrectness",
    target: input.checkTarget,
    baselineObservations: [],
    targetObservations: [],
  });
  expect(await store.get(oldKey)).toBeDefined();
  expect(await store.get(newKey)).toBeUndefined();
});
