import {
  access,
  mkdir,
  mkdtemp,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { inspectRepository } from "../../src/inspection/inspect-repository.js";
import { canonicalizeSnapshotRoot } from "../../src/inspection/read-json.js";
import { createInspectionFixture } from "./fixture.js";

interface InjectedReadHooks {
  afterCanonicalize?(context: {
    readonly canonicalPath: string;
  }): Promise<void> | void;
  beforeOpen?(context: {
    readonly canonicalPath: string;
  }): Promise<void> | void;
  afterOpen?(context: { readonly canonicalPath: string }): Promise<void> | void;
}

function inspectWithReadHooks(
  root: string,
  readHooks: (repositoryPath: string) => InjectedReadHooks | undefined,
) {
  const inspectWithDependencies = inspectRepository as (
    snapshotRoot: string,
    dependencies: {
      readHooks(path: string): InjectedReadHooks | undefined;
    },
  ) => ReturnType<typeof inspectRepository>;
  return inspectWithDependencies(root, { readHooks });
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

describe("inspectRepository", () => {
  it.each([
    ["npm@11.4.0", "package-lock.json", "npm"],
    ["pnpm@10.15.0", "pnpm-lock.yaml", "pnpm"],
    ["yarn@4.9.2", "yarn.lock", "yarn"],
    ["bun@1.2.20", "bun.lock", "bun"],
  ] as const)(
    "uses a valid declared %s package manager",
    async (declaration, lockfile, expected) => {
      const fixture = await createInspectionFixture();
      await fixture.writeJson("package.json", { packageManager: declaration });
      await fixture.write(lockfile, "lockfile fixture\n");
      await fixture.write("package-lock.json", "{}\n");

      const inspection = await inspectRepository(fixture.root);

      expect(inspection.packageManager).toBe(expected);
    },
  );

  it.each([
    ["package-lock.json", "npm"],
    ["npm-shrinkwrap.json", "npm"],
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["bun.lock", "bun"],
    ["bun.lockb", "bun"],
  ] as const)("detects %s as %s snapshot data", async (lockfile, expected) => {
    const fixture = await createInspectionFixture();
    await fixture.writeJson("package.json", {});
    await fixture.write(lockfile, "lockfile fixture\n");

    const inspection = await inspectRepository(fixture.root);

    expect(inspection.packageManager).toBe(expected);
    expect(inspection.lockfiles).toEqual([lockfile]);
  });

  it("falls back from an invalid declaration to deterministic lockfile precedence", async () => {
    const fixture = await createInspectionFixture();
    await fixture.writeJson("package.json", { packageManager: "pnpm@latest" });
    for (const lockfile of [
      "yarn.lock",
      "pnpm-lock.yaml",
      "package-lock.json",
      "bun.lockb",
    ]) {
      await fixture.write(lockfile, "lockfile fixture\n");
    }

    const inspection = await inspectRepository(fixture.root);

    expect(inspection.packageManager).toBe("npm");
    expect(inspection.lockfiles).toEqual([
      "bun.lockb",
      "package-lock.json",
      "pnpm-lock.yaml",
      "yarn.lock",
    ]);
  });

  it("ignores lockfiles outside the Git root and declared workspace roots", async () => {
    const fixture = await createInspectionFixture();
    await fixture.writeJson("package.json", { name: "root" });
    await fixture.write("package-lock.json", "{}\n");
    await fixture.write(
      "test/fixtures/lockfiles/bun/bun.lockb",
      "intentional binary-lockfile fixture\n",
    );

    const inspection = await inspectRepository(fixture.root);

    expect(inspection.packageManager).toBe("npm");
    expect(inspection.lockfiles).toEqual(["package-lock.json"]);
  });

  it("includes lockfiles located directly in declared workspace roots", async () => {
    const fixture = await createInspectionFixture();
    await fixture.writeJson("package.json", {
      name: "root",
      workspaces: ["packages/*"],
    });
    await fixture.write("package-lock.json", "{}\n");
    await fixture.writeJson("packages/app/package.json", { name: "app" });
    await fixture.write("packages/app/bun.lock", "lockfile fixture\n");
    await fixture.write(
      "packages/app/test/fixtures/yarn.lock",
      "fixture nested beneath a workspace\n",
    );

    const inspection = await inspectRepository(fixture.root);

    expect(inspection.lockfiles).toEqual([
      "package-lock.json",
      "packages/app/bun.lock",
    ]);
  });

  it("returns unknown without a root manifest or supported lockfile", async () => {
    const fixture = await createInspectionFixture();
    await fixture.write("README.md", "fixture\n");

    const inspection = await inspectRepository(fixture.root);

    expect(inspection.packageManager).toBe("unknown");
    expect(inspection.workspaces).toEqual([]);
    expect(inspection.lockfiles).toEqual([]);
  });

  it("infers environments from all dependency sections without implying DOM for Ink", async () => {
    const fixture = await createInspectionFixture();
    await fixture.writeJson("package.json", {
      packageManager: "pnpm@10.15.0",
      workspaces: ["apps/*", "packages/*"],
      devDependencies: { vitest: "4.1.0", "@testing-library/react": "16.0.0" },
      optionalDependencies: { jest: "30.0.0" },
    });
    await fixture.write("pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
    await fixture.writeJson("apps/web/package.json", {
      name: "web",
      dependencies: { react: "19.0.0", next: "16.0.0" },
      peerDependencies: { "react-dom": "19.0.0" },
    });
    await fixture.write(
      "apps/web/src/page.tsx",
      "export default function Page() { return null; }\n",
    );
    await fixture.writeJson("packages/cli/package.json", {
      name: "cli",
      dependencies: { react: "19.0.0" },
      optionalDependencies: { ink: "7.0.0" },
    });
    await fixture.write(
      "packages/cli/src/index.tsx",
      "export const App = () => null;\n",
    );

    const inspection = await inspectRepository(fixture.root);
    const web = inspection.workspaces.find(
      ({ relativeRoot }) => relativeRoot === "apps/web",
    );
    const cli = inspection.workspaces.find(
      ({ relativeRoot }) => relativeRoot === "packages/cli",
    );

    expect(inspection.packageManager).toBe("pnpm");
    expect(web?.environments).toEqual([
      "javascript",
      "typescript",
      "react",
      "react-dom",
      "next",
    ]);
    expect(cli?.environments).toEqual([
      "javascript",
      "typescript",
      "react",
      "ink",
    ]);
    expect(cli?.environments).not.toContain("react-dom");
    expect(inspection.workspaces[0]?.environments).toEqual([
      "javascript",
      "vitest",
      "jest",
      "testing-library",
    ]);
  });

  it("infers React DOM from Remix and never imports executable repository config", async () => {
    const fixture = await createInspectionFixture();
    const sentinel = `${fixture.root}/executed`;
    await fixture.writeJson("package.json", {
      dependencies: { react: "19.0.0", "@remix-run/react": "2.0.0" },
    });
    await fixture.write(
      "vite.config.js",
      `await import('node:fs/promises').then(({ writeFile }) => writeFile(${JSON.stringify(sentinel)}, 'bad'));\n`,
    );
    await fixture.write("src/index.jsx", "export const App = () => null;\n");

    const inspection = await inspectRepository(fixture.root);

    expect(inspection.workspaces[0]?.environments).toEqual([
      "javascript",
      "react",
      "react-dom",
      "remix",
    ]);
    expect(await pathExists(sentinel)).toBe(false);
  });

  it.each(["@remix-run/router", "@remix-run/node", "@remix-run/eslint-config"])(
    "does not infer Remix or React DOM from the non-runtime package %s",
    async (dependency) => {
      const fixture = await createInspectionFixture();
      await fixture.writeJson("package.json", {
        dependencies: { [dependency]: "2.0.0" },
      });

      const inspection = await inspectRepository(fixture.root);

      expect(inspection.workspaces[0]?.environments).toEqual(["javascript"]);
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects a selected file swapped after validation without returning outside bytes",
    async () => {
      const fixture = await createInspectionFixture();
      const outside = await mkdtemp(join(tmpdir(), "zedbee-inspection-race-"));
      onTestFinished(() => rm(outside, { recursive: true, force: true }));
      const outsideManifest = join(outside, "outside.json");
      await fixture.writeJson("package.json", { origin: "inside" });
      await writeFile(
        outsideManifest,
        JSON.stringify({ origin: "outside", secret: "must never be returned" }),
      );
      await expect(
        inspectWithReadHooks(fixture.root, (repositoryPath) =>
          repositoryPath === "package.json"
            ? {
                async beforeOpen({ canonicalPath }) {
                  await rename(canonicalPath, `${canonicalPath}.validated`);
                  await symlink(outsideManifest, canonicalPath);
                },
              }
            : undefined,
        ),
      ).rejects.toMatchObject({
        code: "UNSAFE_SNAPSHOT_PATH",
        message: "Zedbee refused a path outside the snapshot.",
      });
    },
  );

  it.runIf(process.platform !== "win32").each(["persists", "swaps back"])(
    "rejects an ancestor directory swap that %s after the file is opened",
    async (swapMode) => {
      const fixture = await createInspectionFixture();
      const outside = await mkdtemp(
        join(tmpdir(), "zedbee-inspection-ancestor-race-"),
      );
      onTestFinished(() => rm(outside, { recursive: true, force: true }));
      await fixture.writeJson("package.json", {
        workspaces: ["packages/*"],
      });
      await fixture.writeJson("packages/app/package.json", {
        origin: "inside",
      });
      await mkdir(join(outside, "app"), { recursive: true });
      await writeFile(
        join(outside, "app/package.json"),
        JSON.stringify({
          origin: "outside",
          secret: "ancestor bytes must never be returned",
        }),
      );
      const canonicalRoot = await canonicalizeSnapshotRoot(fixture.root);
      const packagesRoot = join(canonicalRoot, "packages");
      const validatedPackagesRoot = join(canonicalRoot, "packages.validated");

      await expect(
        inspectWithReadHooks(fixture.root, (repositoryPath) =>
          repositoryPath === "packages/app/package.json"
            ? {
                async afterCanonicalize() {
                  await rename(packagesRoot, validatedPackagesRoot);
                  await symlink(outside, packagesRoot);
                },
                async afterOpen() {
                  if (swapMode === "swaps back") {
                    await unlink(packagesRoot);
                    await rename(validatedPackagesRoot, packagesRoot);
                  }
                },
              }
            : undefined,
        ),
      ).rejects.toMatchObject({
        code: "UNSAFE_SNAPSHOT_PATH",
        message: "Zedbee refused a path outside the snapshot.",
      });
    },
  );

  it("enumerates captured source files after their directory is removed", async () => {
    const fixture = await createInspectionFixture();
    await fixture.writeJson("package.json", { name: "root" });
    await fixture.write("src/index.ts", "export const captured = true;\n");

    const inspection = await inspectWithReadHooks(
      fixture.root,
      (repositoryPath) =>
        repositoryPath === "package.json"
          ? {
              async afterOpen() {
                await rm(join(fixture.root, "src"), {
                  recursive: true,
                  force: true,
                });
              },
            }
          : undefined,
    );

    expect(inspection.workspaces[0]?.sourceFiles).toEqual(["src/index.ts"]);
  });

  it("does not silently omit a captured workspace removed after registry capture", async () => {
    const fixture = await createInspectionFixture();
    await fixture.writeJson("package.json", { workspaces: ["packages/*"] });
    await fixture.writeJson("packages/app/package.json", { name: "app" });

    await expect(
      inspectWithReadHooks(fixture.root, (repositoryPath) =>
        repositoryPath === "package.json"
          ? {
              async afterOpen() {
                await rename(
                  join(fixture.root, "packages"),
                  join(fixture.root, "packages.after-capture"),
                );
              },
            }
          : undefined,
      ),
    ).rejects.toMatchObject({ code: "INVALID_SNAPSHOT_DATA" });
  });

  it("deeply freezes every returned record and array", async () => {
    const fixture = await createInspectionFixture();
    await fixture.writeJson("package.json", {
      name: "root",
      dependencies: { react: "19.0.0" },
    });
    await fixture.write("src/index.ts", "export const value = true;\n");

    const inspection = await inspectRepository(fixture.root);
    const workspace = inspection.workspaces[0];

    expect(Object.isFrozen(inspection)).toBe(true);
    expect(Object.isFrozen(inspection.lockfiles)).toBe(true);
    expect(Object.isFrozen(inspection.workspaces)).toBe(true);
    expect(Object.isFrozen(workspace)).toBe(true);
    expect(Object.isFrozen(workspace?.sourceFiles)).toBe(true);
    expect(Object.isFrozen(workspace?.tsconfigPaths)).toBe(true);
    expect(Object.isFrozen(workspace?.environments)).toBe(true);
    expect(() => (inspection.workspaces as unknown[]).push({})).toThrow(
      TypeError,
    );
    expect(() =>
      (workspace?.sourceFiles as string[]).push("changed.ts"),
    ).toThrow(TypeError);
    expect(inspection.workspaces[0]?.sourceFiles).toEqual(["src/index.ts"]);
  });
});
