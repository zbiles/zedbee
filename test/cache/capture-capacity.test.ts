import { expect, it } from "vitest";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { CapturedDependencies } from "../../src/cache/captured-dependencies.js";
import { DEPENDENCY_LIMITS } from "../../src/cache/dependency-inputs.js";
import { verifyComparisonInputs } from "../../src/checks/comparison-context.js";
import { createInspectionFixture } from "../inspection/fixture.js";

it("keeps a complete validated dependency witness beyond twenty thousand probes", async () => {
  const fixture = await createInspectionFixture();
  const view = new CapturedDependencies({ repositoryRoot: fixture.root });
  for (let index = 0; index < 21_000; index++) {
    expect(
      view.fileExists(
        join(fixture.root, "node_modules", `pkg-${index}`, "index.d.ts"),
      ),
    ).toBe(false);
  }
  const manifest = view.manifest();
  expect(manifest?.probes).toHaveLength(21_000);
  expect(view.failure()).toBeUndefined();
  expect(view.validate(manifest!)).toBe(true);
  await fixture.write(
    "node_modules/pkg-0/index.d.ts",
    "export declare const value: number;\n",
  );
  expect(view.validate(manifest!)).toBe(false);
});

it("reports a bounded probe-capacity failure without accepting an incomplete comparison", async () => {
  const fixture = await createInspectionFixture();
  const view = new CapturedDependencies({ repositoryRoot: fixture.root });
  for (let index = 0; index <= DEPENDENCY_LIMITS.probes; index++) {
    view.fileExists(join(fixture.root, "node_modules", `p${index}`));
  }
  expect(view.manifest()).toBeUndefined();
  expect(view.failure()).toEqual({
    reason: "capacity",
    resource: "probes",
    observed: DEPENDENCY_LIMITS.probes + 1,
    limit: DEPENDENCY_LIMITS.probes,
  });
  expect(Object.isFrozen(view.failure())).toBe(true);
  expect(() => verifyComparisonInputs(view)).toThrowError(
    expect.objectContaining({ code: "COMPARISON_INPUTS_LIMIT_EXCEEDED" }),
  );
});

it("distinguishes a metadata-capacity failure from missing packages", async () => {
  const fixture = await createInspectionFixture();
  const view = new CapturedDependencies({ repositoryRoot: fixture.root });
  const prefix = Array.from(
    { length: 6 },
    (_, index) => `${index}${"x".repeat(95)}`,
  ).join("/");
  for (
    let index = 0;
    index < DEPENDENCY_LIMITS.probes && view.failure() === undefined;
    index++
  ) {
    view.fileExists(join(fixture.root, "node_modules", prefix, `p${index}`));
  }
  expect(view.failure()).toMatchObject({
    reason: "capacity",
    resource: "metadataBytes",
    limit: DEPENDENCY_LIMITS.metadataBytes,
  });
  expect(view.manifest()).toBeUndefined();
  expect(() => verifyComparisonInputs(view)).toThrowError(
    expect.objectContaining({
      code: "COMPARISON_INPUTS_LIMIT_EXCEEDED",
      message: expect.stringContaining("metadata"),
    }),
  );
});

it("reports the existing per-file byte limit separately and keeps its first failure", async () => {
  const fixture = await createInspectionFixture();
  const file = join(fixture.root, "node_modules", "large", "index.d.ts");
  await fixture.write("node_modules/large/package.json", '{"name":"large"}');
  await writeFile(file, Buffer.alloc(DEPENDENCY_LIMITS.fileBytes + 1, 32));
  const view = new CapturedDependencies({ repositoryRoot: fixture.root });
  view.fileExists(file);
  expect(view.failure()).toEqual({
    reason: "capacity",
    resource: "fileBytes",
    observed: DEPENDENCY_LIMITS.fileBytes + 1,
    limit: DEPENDENCY_LIMITS.fileBytes,
  });
  view.fileExists("/unrelated-untrusted-root/denied");
  expect(view.failure()).toMatchObject({ resource: "fileBytes" });
  expect(() => verifyComparisonInputs(view)).toThrowError(
    expect.objectContaining({ code: "COMPARISON_INPUTS_LIMIT_EXCEEDED" }),
  );
});

it("keeps unsupported lookup scopes distinct from capacity failures", async () => {
  const fixture = await createInspectionFixture();
  const view = new CapturedDependencies({ repositoryRoot: fixture.root });
  view.fileExists("/unsupported-root/secret-source.ts");
  expect(view.failure()).toEqual({ reason: "unsupported-scope" });
  expect(view.manifest()).toBeUndefined();
  expect(JSON.stringify(view.failure())).not.toContain("secret-source");
  expect(() => verifyComparisonInputs(view)).toThrowError(
    expect.objectContaining({ code: "COMPARISON_INPUTS_UNVERIFIED" }),
  );
});
