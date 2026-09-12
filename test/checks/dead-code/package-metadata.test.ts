import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CapturedDependencies,
  validateDependencyInputs,
} from "../../../src/cache/captured-dependencies.js";
import { createPackageMetadataReader } from "../../../src/checks/dead-code/package-metadata.js";
import { createInspectionFixture } from "../../inspection/fixture.js";

describe("Knip package command metadata", () => {
  it("reads nested installed JSON as data and retains missing probes for cache invalidation", async () => {
    const live = await createInspectionFixture();
    const path = "web/node_modules/@tools/runner/package.json";
    const capture = new CapturedDependencies(
      { repositoryRoot: live.root },
      "knip",
    );
    const read = createPackageMetadataReader(capture);
    expect(() => read(`/snapshot/${path}`)).toThrow("unavailable");
    const missing = capture.manifest();
    await live.writeJson(path, {
      bin: { "project-check": "cli.js" },
      scripts: { postinstall: "exit 99" },
      exports: "./malicious.js",
    });
    expect(
      validateDependencyInputs(missing, { repositoryRoot: live.root }, "knip"),
    ).toBe(false);
    const fresh = new CapturedDependencies(
      { repositoryRoot: live.root },
      "knip",
    );
    expect(createPackageMetadataReader(fresh)(`/snapshot/${path}`)).toEqual({
      bin: { "project-check": "cli.js" },
    });
    await live.write(
      "web/node_modules/@tools/runner/cli.js",
      "throw new Error('never load');",
    );
    expect(
      fresh.readFile(join(live.root, "web/node_modules/@tools/runner/cli.js")),
    ).toBeUndefined();
  });

  it("rejects code paths, traversal, live files and links outside installed packages", async () => {
    const live = await createInspectionFixture();
    const outside = await createInspectionFixture();
    await outside.writeJson("package.json", { bin: "cli.js" });
    await live.writeJson("private/package.json", { bin: "cli.js" });
    await live.symlink(
      join(outside.root, "package.json"),
      "node_modules/external/package.json",
    );
    await live.symlink(
      "../../private/package.json",
      "node_modules/linked/package.json",
    );
    const read = createPackageMetadataReader(
      new CapturedDependencies({ repositoryRoot: live.root }, "knip"),
    );
    for (const path of [
      "/snapshot/private/package.json",
      "/snapshot/node_modules/external/package.json",
      "/snapshot/node_modules/linked/package.json",
      "/snapshot/../node_modules/example/package.json",
      "/snapshot/node_modules/example/cli.js",
      "/snapshot/node_modules/a\\b/package.json",
    ])
      expect(() => read(path)).toThrow();
  });
});
