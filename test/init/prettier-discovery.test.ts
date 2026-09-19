import { lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { discoverProjectPrettier } from "../../src/init/prettier-discovery.js";
import { createInspectionFixture } from "../inspection/fixture.js";

async function markerExists(root: string, name: string): Promise<boolean> {
  try {
    await lstat(join(root, name));
    return true;
  } catch {
    return false;
  }
}

describe("discoverProjectPrettier", () => {
  it("finds a declared and installed project Prettier", async () => {
    const fixture = await createInspectionFixture();
    await fixture.writeJson("package.json", {
      name: "app",
      devDependencies: { prettier: "^3.0.0" },
    });
    await fixture.writeJson("node_modules/prettier/package.json", {
      name: "prettier",
      version: "3.9.6",
    });
    await fixture.write(".prettierrc.json", "{}");

    const discovered = await discoverProjectPrettier(fixture.root);

    expect(discovered).toHaveLength(1);
    expect(discovered[0]).toMatchObject({
      projectRoot: ".",
      version: "3.9.6",
      status: "available",
      executableConfig: false,
    });
    expect(discovered[0]?.configPaths).toEqual([".prettierrc.json"]);
    expect(discovered[0]?.packageRoot).toContain("node_modules/prettier");
  });

  it("resolves a nested project through a hoisted installation", async () => {
    const fixture = await createInspectionFixture();
    await fixture.writeJson("package.json", {
      name: "root",
      private: true,
      workspaces: ["packages/*"],
      devDependencies: { prettier: "^3.0.0" },
    });
    await fixture.writeJson("packages/app/package.json", {
      name: "app",
      devDependencies: { prettier: "^3.0.0" },
    });
    await fixture.writeJson("node_modules/prettier/package.json", {
      name: "prettier",
      version: "3.3.0",
    });

    const discovered = await discoverProjectPrettier(fixture.root);

    const nested = discovered.find(
      (entry) => entry.projectRoot === "packages/app",
    );
    expect(nested).toMatchObject({ version: "3.3.0", status: "available" });
  });

  it("does not offer a hoisted installation the project never declared or configured", async () => {
    const fixture = await createInspectionFixture();
    await fixture.writeJson("package.json", {
      name: "app",
      devDependencies: { typescript: "^5.0.0" },
    });
    // npm can hoist Zedbee's own transitive Prettier here; it is not a choice.
    await fixture.writeJson("node_modules/prettier/package.json", {
      name: "prettier",
      version: "3.9.6",
    });

    const discovered = await discoverProjectPrettier(fixture.root);

    expect(discovered).toEqual([]);
  });

  it("rejects an installed version that violates the project's declared range", async () => {
    const fixture = await createInspectionFixture();
    await fixture.writeJson("package.json", {
      name: "app",
      devDependencies: { prettier: "~3.3.0" },
    });
    await fixture.writeJson("node_modules/prettier/package.json", {
      name: "prettier",
      version: "3.9.6",
    });

    const discovered = await discoverProjectPrettier(fixture.root);

    expect(discovered[0]).toMatchObject({
      version: "3.9.6",
      declaredRange: "~3.3.0",
      status: "unsupported",
    });
  });

  it("recognizes TypeScript executable configuration forms", async () => {
    const fixture = await createInspectionFixture();
    await fixture.writeJson("package.json", {
      name: "app",
      devDependencies: { prettier: "^3.0.0" },
    });
    await fixture.write(".prettierrc.cts", "export default {}\n");
    await fixture.writeJson("packages/app/package.json", { name: "app" });
    await fixture.write("packages/app/prettier.config.mts", "export default {}\n");

    const discovered = await discoverProjectPrettier(fixture.root);

    const root = discovered.find((entry) => entry.projectRoot === ".");
    expect(root?.configPaths).toEqual([".prettierrc.cts"]);
    expect(root?.executableConfig).toBe(true);
    const nested = discovered.find(
      (entry) => entry.projectRoot === "packages/app",
    );
    expect(nested?.configPaths).toEqual(["packages/app/prettier.config.mts"]);
    expect(nested?.executableConfig).toBe(true);
  });

  it("reports a declared but uninstalled Prettier as missing", async () => {
    const fixture = await createInspectionFixture();
    await fixture.writeJson("package.json", {
      devDependencies: { prettier: "^3.0.0" },
    });

    const discovered = await discoverProjectPrettier(fixture.root);

    expect(discovered).toHaveLength(1);
    expect(discovered[0]).toMatchObject({ projectRoot: ".", status: "missing" });
    expect(discovered[0]?.version).toBeUndefined();
  });

  it("reports an out-of-range installed Prettier as unsupported", async () => {
    const fixture = await createInspectionFixture();
    await fixture.writeJson("package.json", {
      devDependencies: { prettier: "4.0.0" },
    });
    await fixture.writeJson("node_modules/prettier/package.json", {
      name: "prettier",
      version: "4.0.0",
    });

    const discovered = await discoverProjectPrettier(fixture.root);

    expect(discovered[0]).toMatchObject({
      version: "4.0.0",
      status: "unsupported",
    });
  });

  it("does not follow an installation symlink outside the repository", async () => {
    const fixture = await createInspectionFixture();
    const outside = await mkdtemp(join(tmpdir(), "zedbee-prettier-outside-"));
    onTestFinished(() => rm(outside, { recursive: true, force: true }));
    await fixture.writeJson("package.json", {
      devDependencies: { prettier: "^3.0.0" },
    });
    await fixture.symlink(outside, "node_modules/prettier");

    const discovered = await discoverProjectPrettier(fixture.root);

    expect(discovered[0]).toMatchObject({ status: "missing" });
    expect(discovered[0]?.packageRoot).toBeUndefined();
  });

  it("finds an executable config without executing it", async () => {
    const fixture = await createInspectionFixture();
    await fixture.writeJson("package.json", {
      devDependencies: { prettier: "^3.0.0" },
    });
    await fixture.write(
      "prettier.config.mjs",
      "import { writeFileSync } from 'node:fs';\n" +
        "writeFileSync(new URL('./MARKER_EXECUTED', import.meta.url), 'executed');\n" +
        "export default { singleQuote: true };\n",
    );

    const discovered = await discoverProjectPrettier(fixture.root);

    expect(discovered[0]?.configPaths).toEqual(["prettier.config.mjs"]);
    expect(discovered[0]?.executableConfig).toBe(true);
    expect(await markerExists(fixture.root, "MARKER_EXECUTED")).toBe(false);
  });
});
