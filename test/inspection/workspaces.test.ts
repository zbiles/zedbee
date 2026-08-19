import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { inspectRepository } from "../../src/inspection/inspect-repository.js";
import { parsePackageManifest } from "../../src/inspection/workspaces.js";
import { createInspectionFixture } from "./fixture.js";

describe("workspace discovery", () => {
  it("retains dependency declarations in fixed section precedence", () => {
    expect(
      parsePackageManifest(
        {
          dependencies: { react: "^18.2.0" },
          devDependencies: { vitest: "4.1.10" },
          peerDependencies: { "react-dom": ">=18" },
        },
        "package.json",
      ).dependencyDeclarations,
    ).toEqual([
      { name: "react", specifier: "^18.2.0", section: "dependencies" },
      { name: "vitest", specifier: "4.1.10", section: "devDependencies" },
      { name: "react-dom", specifier: ">=18", section: "peerDependencies" },
    ]);
  });

  it("rejects a non-string dependency declaration", () => {
    expect(() =>
      parsePackageManifest(
        { dependencies: { react: { version: "19.2.0" } } },
        "package.json",
      ),
    ).toThrowError(/invalid repository data/u);
  });

  it("orders and freezes dependency declarations across all manifest sections", () => {
    const declarations = parsePackageManifest(
      {
        dependencies: { zebra: "1.0.0", alpha: "2.0.0" },
        optionalDependencies: { optional: "3.0.0" },
        devDependencies: { development: "4.0.0" },
        peerDependencies: { peer: "5.0.0" },
      },
      "package.json",
    ).dependencyDeclarations;

    expect(declarations).toEqual([
      { name: "alpha", specifier: "2.0.0", section: "dependencies" },
      { name: "zebra", specifier: "1.0.0", section: "dependencies" },
      {
        name: "optional",
        specifier: "3.0.0",
        section: "optionalDependencies",
      },
      {
        name: "development",
        specifier: "4.0.0",
        section: "devDependencies",
      },
      { name: "peer", specifier: "5.0.0", section: "peerDependencies" },
    ]);
    expect(Object.isFrozen(declarations)).toBe(true);
    expect(Object.isFrozen(declarations[0])).toBe(true);
  });

  it("discovers array-form workspaces in deterministic root-first order", async () => {
    const fixture = await createInspectionFixture();
    await fixture.writeJson("package.json", {
      name: "root",
      workspaces: ["packages/*", "apps/*"],
    });
    await fixture.writeJson("packages/cli/package.json", { name: "cli" });
    await fixture.writeJson("apps/web/package.json", { name: "web" });

    const inspection = await inspectRepository(fixture.root);

    expect(
      inspection.workspaces.map(({ relativeRoot }) => relativeRoot),
    ).toEqual([".", "apps/web", "packages/cli"]);
    expect(
      inspection.workspaces.map(({ manifestPath }) => manifestPath),
    ).toEqual([
      "package.json",
      "apps/web/package.json",
      "packages/cli/package.json",
    ]);
  });

  it("discovers object-form workspaces, nested packages, and deduplicates overlapping globs", async () => {
    const fixture = await createInspectionFixture();
    await fixture.writeJson("package.json", {
      workspaces: {
        packages: ["packages/**", "packages/*", "packages/tools/*"],
      },
    });
    await fixture.writeJson("packages/core/package.json", { name: "core" });
    await fixture.writeJson("packages/tools/linter/package.json", {
      name: "linter",
    });

    const inspection = await inspectRepository(fixture.root);

    expect(
      inspection.workspaces.map(({ relativeRoot }) => relativeRoot),
    ).toEqual([".", "packages/core", "packages/tools/linter"]);
  });

  it("combines pnpm workspace packages with manifest workspaces", async () => {
    const fixture = await createInspectionFixture();
    await fixture.writeJson("package.json", { workspaces: ["apps/*"] });
    await fixture.write(
      "pnpm-workspace.yaml",
      "packages:\n  - packages/*\n  - apps/*\n",
    );
    await fixture.writeJson("apps/web/package.json", { name: "web" });
    await fixture.writeJson("packages/cli/package.json", { name: "cli" });

    const inspection = await inspectRepository(fixture.root);

    expect(
      inspection.workspaces.map(({ relativeRoot }) => relativeRoot),
    ).toEqual([".", "apps/web", "packages/cli"]);
  });

  it("honors a negated manifest workspace glob while retaining included siblings", async () => {
    const fixture = await createInspectionFixture();
    await fixture.writeJson("package.json", {
      workspaces: ["packages/*", "!packages/excluded"],
    });
    await fixture.writeJson("packages/included/package.json", {
      name: "included",
    });
    await fixture.writeJson("packages/excluded/package.json", {
      name: "excluded",
    });

    const inspection = await inspectRepository(fixture.root);

    expect(
      inspection.workspaces.map(({ relativeRoot }) => relativeRoot),
    ).toEqual([".", "packages/included"]);
  });

  it("honors a negated pnpm workspace glob while retaining included siblings", async () => {
    const fixture = await createInspectionFixture();
    await fixture.writeJson("package.json", {});
    await fixture.write(
      "pnpm-workspace.yaml",
      "packages:\n  - packages/*\n  - '!packages/excluded'\n",
    );
    await fixture.writeJson("packages/included/package.json", {
      name: "included",
    });
    await fixture.writeJson("packages/excluded/package.json", {
      name: "excluded",
    });

    const inspection = await inspectRepository(fixture.root);

    expect(
      inspection.workspaces.map(({ relativeRoot }) => relativeRoot),
    ).toEqual([".", "packages/included"]);
  });

  it("preserves dot-workspace matching from frozen registry entries", async () => {
    const fixture = await createInspectionFixture();
    await fixture.writeJson("package.json", { workspaces: ["packages/*"] });
    await fixture.writeJson("packages/.hidden/package.json", {
      name: "hidden",
    });

    const inspection = await inspectRepository(fixture.root);

    expect(
      inspection.workspaces.map(({ relativeRoot }) => relativeRoot),
    ).toEqual([".", "packages/.hidden"]);
  });

  it("does not discover packages or sources in dependencies, metadata, generated, or vendor trees", async () => {
    const fixture = await createInspectionFixture();
    await fixture.writeJson("package.json", { workspaces: ["**"] });
    await fixture.write("src/index.ts", "export const root = true;\n");
    for (const directory of [
      "node_modules/hidden",
      ".git/hidden",
      ".zedbee/hidden",
      "generated/hidden",
      "vendor/hidden",
    ]) {
      await fixture.writeJson(`${directory}/package.json`, { name: "hidden" });
      await fixture.write(
        `${directory}/index.ts`,
        "throw new Error('must be ignored');\n",
      );
    }

    const inspection = await inspectRepository(fixture.root);

    expect(
      inspection.workspaces.map(({ relativeRoot }) => relativeRoot),
    ).toEqual(["."]);
    expect(inspection.workspaces[0]?.sourceFiles).toEqual(["src/index.ts"]);
  });

  it("assigns nested source and TypeScript config paths only to their owning workspace", async () => {
    const fixture = await createInspectionFixture();
    await fixture.writeJson("package.json", { workspaces: ["packages/*"] });
    await fixture.write("src/root.ts", "export const root = true;\n");
    await fixture.writeJson("tsconfig.json", { compilerOptions: {} });
    await fixture.writeJson("packages/web/package.json", { name: "web" });
    await fixture.write(
      "packages/web/src/view.tsx",
      "export const View = () => null;\n",
    );
    await fixture.writeJson("packages/web/tsconfig.build.json", {
      compilerOptions: {},
    });

    const inspection = await inspectRepository(fixture.root);

    expect(inspection.workspaces[0]?.sourceFiles).toEqual(["src/root.ts"]);
    expect(inspection.workspaces[0]?.tsconfigPaths).toEqual(["tsconfig.json"]);
    expect(inspection.workspaces[1]?.sourceFiles).toEqual([
      "packages/web/src/view.tsx",
    ]);
    expect(inspection.workspaces[1]?.tsconfigPaths).toEqual([
      "packages/web/tsconfig.build.json",
    ]);
  });

  it.each([
    ["root manifest", "package.json", "{ secret source text"],
    [
      "selected workspace manifest",
      "packages/broken/package.json",
      "{ workspace secret",
    ],
    ["pnpm workspace config", "pnpm-workspace.yaml", "packages: [unterminated"],
  ])(
    "rejects a malformed %s without exposing its contents",
    async (_name, path, contents) => {
      const fixture = await createInspectionFixture();
      await fixture.writeJson("package.json", { workspaces: ["packages/*"] });
      if (path === "package.json") {
        await fixture.write(path, contents);
      } else {
        await fixture.writeJson("packages/good/package.json", { name: "good" });
        if (path.includes("packages/broken")) {
          await fixture.write(path, contents);
        } else {
          await fixture.write(path, contents);
        }
      }

      await expect(inspectRepository(fixture.root)).rejects.toSatisfy(
        (error: unknown) => {
          expect(error).toBeInstanceOf(Error);
          expect((error as Error).message).not.toContain("secret");
          expect((error as Error).message).not.toContain(fixture.root);
          return true;
        },
      );
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects a workspace symlink that escapes the snapshot before reading its manifest",
    async () => {
      const fixture = await createInspectionFixture();
      const outside = await mkdtemp(
        join(tmpdir(), "zedbee-inspection-outside-"),
      );
      onTestFinished(() => rm(outside, { recursive: true, force: true }));
      await writeFile(
        join(outside, "package.json"),
        "{ private material that is not JSON",
      );
      await fixture.writeJson("package.json", { workspaces: ["packages/*"] });
      await mkdir(join(fixture.root, "packages"), { recursive: true });
      await fixture.symlink(outside, "packages/escape");

      await expect(inspectRepository(fixture.root)).rejects.toSatisfy(
        (error: unknown) => {
          expect(error).toBeInstanceOf(Error);
          expect((error as Error).message).toContain("outside the snapshot");
          expect((error as Error).message).not.toContain("private material");
          expect((error as Error).message).not.toContain(outside);
          return true;
        },
      );
    },
  );

  it.runIf(process.platform !== "win32")(
    "ignores a contained source-file symlink when selecting broad workspace globs",
    async () => {
      const fixture = await createInspectionFixture();
      await fixture.writeJson("package.json", { workspaces: ["packages/**"] });
      await fixture.writeJson("packages/app/package.json", { name: "app" });
      await fixture.write(
        "packages/app/src/target.ts",
        "export const target = true;\n",
      );
      await symlink(
        "target.ts",
        join(fixture.root, "packages/app/src/link.ts"),
      );

      const inspection = await inspectRepository(fixture.root);

      expect(
        inspection.workspaces.map(({ relativeRoot }) => relativeRoot),
      ).toEqual([".", "packages/app"]);
      expect(inspection.workspaces[1]?.sourceFiles).toEqual([
        "packages/app/src/target.ts",
      ]);
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects an escaping manifest symlink in a selected real workspace directory",
    async () => {
      const fixture = await createInspectionFixture();
      const outside = await mkdtemp(
        join(tmpdir(), "zedbee-inspection-manifest-link-"),
      );
      onTestFinished(() => rm(outside, { recursive: true, force: true }));
      const outsideManifest = join(outside, "package.json");
      await writeFile(outsideManifest, JSON.stringify({ name: "outside" }));
      await fixture.writeJson("package.json", { workspaces: ["packages/*"] });
      await mkdir(join(fixture.root, "packages/escape"), { recursive: true });
      await symlink(
        outsideManifest,
        join(fixture.root, "packages/escape/package.json"),
      );

      await expect(inspectRepository(fixture.root)).rejects.toMatchObject({
        code: "UNSAFE_SNAPSHOT_PATH",
        message: "Zedbee refused a path outside the snapshot.",
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "inspects a selected contained workspace-directory symlink without glob traversal",
    async () => {
      const fixture = await createInspectionFixture();
      await fixture.writeJson("package.json", { workspaces: ["packages/*"] });
      await fixture.writeJson("internal/app/package.json", { name: "linked" });
      await fixture.write(
        "internal/app/src/index.ts",
        "export const linked = true;\n",
      );
      await fixture.writeJson("internal/app/tsconfig.json", {
        compilerOptions: {},
      });
      await mkdir(join(fixture.root, "packages"), { recursive: true });
      await symlink("../internal/app", join(fixture.root, "packages/linked"));

      const inspection = await inspectRepository(fixture.root);
      const root = inspection.workspaces[0];
      const linked = inspection.workspaces[1];

      expect(
        inspection.workspaces.map(({ relativeRoot }) => relativeRoot),
      ).toEqual([".", "packages/linked"]);
      expect(linked?.sourceFiles).toEqual(["packages/linked/src/index.ts"]);
      expect(linked?.tsconfigPaths).toEqual(["packages/linked/tsconfig.json"]);
      expect(linked?.environments).toEqual(["javascript", "typescript"]);
      expect(root?.sourceFiles).not.toContain("internal/app/src/index.ts");
      expect(root?.tsconfigPaths).not.toContain("internal/app/tsconfig.json");
    },
  );

  it.runIf(process.platform !== "win32")(
    "keeps a contained manifest-only symlink attributed to its lexical workspace directory",
    async () => {
      const fixture = await createInspectionFixture();
      await fixture.writeJson("package.json", { workspaces: ["packages/*"] });
      await fixture.writeJson("internal/manifests/app.json", {
        name: "manifest-linked",
      });
      await fixture.write(
        "internal/manifests/unrelated.ts",
        "export const unrelated = true;\n",
      );
      await fixture.writeJson("internal/manifests/tsconfig.unrelated.json", {
        compilerOptions: {},
      });
      await fixture.write(
        "packages/app/src/index.ts",
        "export const app = true;\n",
      );
      await fixture.writeJson("packages/app/tsconfig.json", {
        compilerOptions: {},
      });
      await symlink(
        "../../internal/manifests/app.json",
        join(fixture.root, "packages/app/package.json"),
      );

      const inspection = await inspectRepository(fixture.root);
      const root = inspection.workspaces[0];
      const app = inspection.workspaces[1];

      expect(app?.sourceFiles).toEqual(["packages/app/src/index.ts"]);
      expect(app?.tsconfigPaths).toEqual(["packages/app/tsconfig.json"]);
      expect(root?.sourceFiles).toContain("internal/manifests/unrelated.ts");
      expect(root?.tsconfigPaths).toContain(
        "internal/manifests/tsconfig.unrelated.json",
      );
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects an initially escaping nested symlink inside a linked workspace target",
    async () => {
      const fixture = await createInspectionFixture();
      const outside = await mkdtemp(
        join(tmpdir(), "zedbee-inspection-linked-nested-"),
      );
      onTestFinished(() => rm(outside, { recursive: true, force: true }));
      const outsideSource = join(outside, "outside.ts");
      await writeFile(outsideSource, "export const outside = true;\n");
      await fixture.writeJson("package.json", { workspaces: ["packages/*"] });
      await fixture.writeJson("internal/app/package.json", { name: "linked" });
      await mkdir(join(fixture.root, "internal/app/src"), { recursive: true });
      await symlink(
        outsideSource,
        join(fixture.root, "internal/app/src/escape.ts"),
      );
      await mkdir(join(fixture.root, "packages"), { recursive: true });
      await symlink("../internal/app", join(fixture.root, "packages/linked"));

      await expect(inspectRepository(fixture.root)).rejects.toMatchObject({
        code: "UNSAFE_SNAPSHOT_PATH",
        message: "Zedbee refused a path outside the snapshot.",
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects a root manifest symlink that escapes the snapshot before reading it",
    async () => {
      const fixture = await createInspectionFixture();
      const outside = await mkdtemp(
        join(tmpdir(), "zedbee-inspection-outside-"),
      );
      onTestFinished(() => rm(outside, { recursive: true, force: true }));
      const outsideManifest = join(outside, "package.json");
      await writeFile(
        outsideManifest,
        "{ private root material that is not JSON",
      );
      await symlink(outsideManifest, join(fixture.root, "package.json"));

      await expect(inspectRepository(fixture.root)).rejects.toSatisfy(
        (error: unknown) => {
          expect(error).toBeInstanceOf(Error);
          expect((error as Error).message).toContain("outside the snapshot");
          expect((error as Error).message).not.toContain(
            "private root material",
          );
          expect((error as Error).message).not.toContain(outside);
          return true;
        },
      );
    },
  );
});
