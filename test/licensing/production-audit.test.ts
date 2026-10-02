import { expect, it } from "vitest";

it("audits vendored tools and their runtime closure without admitting test-only dependencies", async () => {
  const { productionAuditInputs } = await import(
    new URL("../../scripts/audit-production-dependencies.mjs", import.meta.url)
      .href
  );
  const manifest = {
    name: "fixture",
    version: "1.0.0",
    devDependencies: { tool: "1.0.0", tests: "1.0.0" },
    vendoredDependencies: { tool: "1.0.0" },
  };
  const lockfile = {
    name: "fixture",
    version: "1.0.0",
    lockfileVersion: 3,
    packages: {
      "": manifest,
      "node_modules/tool": {
        version: "1.0.0",
        dev: true,
        dependencies: { runtime: "2.0.0" },
      },
      "node_modules/runtime": { version: "2.0.0", devOptional: true },
      "node_modules/tests": { version: "1.0.0", dev: true },
    },
  };
  const original = structuredClone({ manifest, lockfile });
  const audit = productionAuditInputs(manifest, lockfile);
  expect(audit.manifest.dependencies).toEqual({ tool: "1.0.0" });
  expect(audit.manifest.devDependencies).toEqual({ tests: "1.0.0" });
  expect(audit.lockfile.packages[""].dependencies).toEqual({ tool: "1.0.0" });
  expect(audit.lockfile.packages["node_modules/tool"].dev).toBeUndefined();
  expect(
    audit.lockfile.packages["node_modules/runtime"].devOptional,
  ).toBeUndefined();
  expect(audit.lockfile.packages["node_modules/tests"].dev).toBe(true);
  expect({ manifest, lockfile }).toEqual(original);
});
