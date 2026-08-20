import { describe, expect, it } from "vitest";
import {
  MANAGED_REACT_VERSION,
  resolveReactVersion,
} from "../../../src/checks/react/version.js";
import { inspectRepository } from "../../../src/inspection/inspect-repository.js";
import type {
  DependencyDeclaration,
  DependencySection,
  RepositoryInspection,
  WorkspaceInspection,
} from "../../../src/inspection/types.js";
import { createInspectionFixture } from "../../inspection/fixture.js";

function declaration(
  section: DependencySection,
  specifier: string,
  name = "react",
): DependencyDeclaration {
  return { name, section, specifier };
}

function workspace(
  dependencyDeclarations: readonly DependencyDeclaration[],
): WorkspaceInspection {
  return {
    relativeRoot: ".",
    manifestPath: "package.json",
    sourceFiles: [],
    tsconfigPaths: [],
    environments: ["javascript", "react"],
    dependencyDeclarations,
  };
}

function inspection(current: WorkspaceInspection): RepositoryInspection {
  return {
    snapshotRoot: "/staged/repository",
    packageManager: "unknown",
    lockfiles: [],
    workspaces: [current],
  };
}

async function resolveManifest(
  dependencyDeclarations: readonly DependencyDeclaration[],
) {
  const current = workspace(dependencyDeclarations);
  return resolveReactVersion(inspection(current), current);
}

describe("resolveReactVersion manifest fallback", () => {
  it.each([
    ["an exact version", "18.3.1", "18.3.1"],
    ["a caret range", "^18.2.0", "18.2.0"],
    ["a peer-only bounded range", ">=18 <20", "18.0.0"],
    [
      "a range with an admitted stable release after a prerelease minimum",
      ">=19.0.0-beta.1 <20",
      "19.0.0",
    ],
    [
      "an OR range with a prerelease-only first comparator set",
      ">=19.0.0-beta.1 <19.0.0 || >=20.0.0 <21",
      "20.0.0",
    ],
  ])(
    "resolves %s to its minimum stable version",
    async (_name, specifier, version) => {
      await expect(
        resolveManifest([declaration("peerDependencies", specifier)]),
      ).resolves.toEqual({ version, source: "manifest" });
    },
  );

  it("uses the fixed dependency-section precedence", async () => {
    await expect(
      resolveManifest([
        declaration("peerDependencies", "^15.0.0"),
        declaration("devDependencies", "^16.0.0"),
        declaration("optionalDependencies", "^17.0.0"),
        declaration("dependencies", "^18.0.0"),
      ]),
    ).resolves.toEqual({ version: "18.0.0", source: "manifest" });
  });

  it.each([
    ["an npm alias", "npm:preact@10.27.0"],
    ["a workspace protocol", "workspace:^"],
    ["a link protocol", "link:../react"],
    ["a file protocol", "file:../react"],
    ["a Git dependency", "github:facebook/react"],
    ["a URL dependency", "https://example.test/react.tgz"],
    ["an invalid range", "not-a-version"],
  ])("uses the managed fallback for %s", async (_name, specifier) => {
    await expect(
      resolveManifest([declaration("dependencies", specifier)]),
    ).resolves.toEqual({
      version: "19.2.0",
      source: "fallback",
    });
  });

  it.each([
    ["a prerelease-only range", ">=19.0.0-beta.1 <19.0.0"],
    ["an exact prerelease declaration", "19.0.0-beta.1"],
  ])(
    "uses the managed fallback for peer dependency %s",
    async (_name, specifier) => {
      await expect(
        resolveManifest([declaration("peerDependencies", specifier)]),
      ).resolves.toEqual({
        version: "19.2.0",
        source: "fallback",
      });
    },
  );

  it("uses the managed fallback when React is undeclared", async () => {
    await expect(
      resolveManifest([declaration("dependencies", "19.2.0", "react-dom")]),
    ).resolves.toEqual({
      version: "19.2.0",
      source: "fallback",
    });
  });

  it("uses the managed fallback for ambiguous declarations in one section", async () => {
    await expect(
      resolveManifest([
        declaration("dependencies", "^18.0.0"),
        declaration("dependencies", "^19.0.0"),
      ]),
    ).resolves.toEqual({
      version: "19.2.0",
      source: "fallback",
    });
  });

  it("exports the managed React version used by fallback resolution", () => {
    expect(MANAGED_REACT_VERSION).toBe("19.2.0");
  });
});

async function inspectFixture(
  packageJson: Record<string, unknown>,
  files: Readonly<Record<string, string | Record<string, unknown>>>,
) {
  const repository = await createInspectionFixture();
  await repository.writeJson("package.json", packageJson);
  for (const [path, contents] of Object.entries(files)) {
    if (typeof contents === "string") {
      await repository.write(path, contents);
    } else {
      await repository.writeJson(path, contents);
    }
  }
  return inspectRepository(repository.root);
}

function inspectedWorkspace(
  currentInspection: RepositoryInspection,
  relativeRoot: string,
): WorkspaceInspection {
  const current = currentInspection.workspaces.find(
    (candidate) => candidate.relativeRoot === relativeRoot,
  );
  if (current === undefined) {
    throw new Error(`Fixture did not discover workspace ${relativeRoot}.`);
  }
  return current;
}

describe("resolveReactVersion lockfile association", () => {
  it("scopes workspace-local importers to their lockfile directories", async () => {
    const currentInspection = await inspectFixture(
      { private: true, workspaces: ["packages/*"] },
      {
        "packages/app/package.json": {
          name: "app",
          dependencies: { react: ">=18 <20" },
        },
        "packages/app/pnpm-lock.yaml": [
          "lockfileVersion: '9.0'",
          "importers:",
          "  .:",
          "    dependencies:",
          "      react:",
          "        specifier: ^18.0.0",
          "        version: 18.3.1",
          "packages:",
          "  react@18.3.1: {}",
          "",
        ].join("\n"),
        "packages/admin/package.json": {
          name: "admin",
          dependencies: { react: ">=18 <20" },
        },
        "packages/admin/pnpm-lock.yaml": [
          "lockfileVersion: '9.0'",
          "importers:",
          "  .:",
          "    dependencies:",
          "      react:",
          "        specifier: ^19.0.0",
          "        version: 19.2.0",
          "packages:",
          "  react@19.2.0: {}",
          "",
        ].join("\n"),
      },
    );

    await expect(
      resolveReactVersion(
        currentInspection,
        inspectedWorkspace(currentInspection, "packages/app"),
      ),
    ).resolves.toEqual({ version: "18.3.1", source: "lockfile" });
    await expect(
      resolveReactVersion(
        currentInspection,
        inspectedWorkspace(currentInspection, "packages/admin"),
      ),
    ).resolves.toEqual({ version: "19.2.0", source: "lockfile" });
  });

  it("does not attribute a sibling workspace's global lockfile record", async () => {
    const currentInspection = await inspectFixture(
      { private: true, workspaces: ["packages/*"] },
      {
        "packages/app/package.json": {
          name: "app",
          dependencies: { react: ">=18 <20" },
        },
        "packages/admin/package.json": {
          name: "admin",
        },
        "packages/admin/yarn.lock": [
          "# yarn lockfile v1",
          "",
          "react@^19.0.0:",
          '  version "19.2.0"',
          "",
        ].join("\n"),
      },
    );

    await expect(
      resolveReactVersion(
        currentInspection,
        inspectedWorkspace(currentInspection, "packages/app"),
      ),
    ).resolves.toEqual({ version: "18.0.0", source: "manifest" });
  });

  it("prefers an npm direct importer match over another compatible version", async () => {
    const currentInspection = await inspectFixture(
      { private: true, workspaces: ["packages/*"] },
      {
        "packages/app/package.json": {
          name: "app",
          dependencies: { react: ">=18 <20" },
        },
        "package-lock.json": {
          lockfileVersion: 3,
          packages: {
            "": {},
            "node_modules/react": { version: "19.2.0" },
            "packages/app": {},
            "packages/app/node_modules/react": { version: "18.3.1" },
            "packages/app/node_modules/tool/node_modules/react": {
              version: "17.0.2",
            },
          },
        },
      },
    );

    await expect(
      resolveReactVersion(
        currentInspection,
        inspectedWorkspace(currentInspection, "packages/app"),
      ),
    ).resolves.toEqual({ version: "18.3.1", source: "lockfile" });
  });

  it("uses one globally compatible direct Yarn version", async () => {
    const currentInspection = await inspectFixture(
      { dependencies: { react: "^19.0.0" } },
      {
        "yarn.lock": [
          "# yarn lockfile v1",
          "",
          "react@^19.0.0:",
          '  version "19.2.0"',
          "",
        ].join("\n"),
      },
    );
    const current = inspectedWorkspace(currentInspection, ".");

    await expect(
      resolveReactVersion(currentInspection, current),
    ).resolves.toEqual({ version: "19.2.0", source: "lockfile" });
  });

  it("declines to choose among multiple compatible global Yarn versions", async () => {
    const currentInspection = await inspectFixture(
      { dependencies: { react: ">=18 <20" } },
      {
        "yarn.lock": [
          "# yarn lockfile v1",
          "",
          "react@^18.0.0:",
          '  version "18.3.1"',
          "",
          "react@^19.0.0:",
          '  version "19.2.0"',
          "",
        ].join("\n"),
      },
    );
    const current = inspectedWorkspace(currentInspection, ".");

    await expect(
      resolveReactVersion(currentInspection, current),
    ).resolves.toEqual({ version: "18.0.0", source: "manifest" });
  });

  it("uses an exact pnpm importer version", async () => {
    const currentInspection = await inspectFixture(
      {
        packageManager: "pnpm@10.0.0",
        dependencies: { react: "^18.2.0" },
      },
      {
        "pnpm-lock.yaml": [
          "lockfileVersion: '9.0'",
          "importers:",
          "  .:",
          "    dependencies:",
          "      react:",
          "        specifier: ^18.2.0",
          "        version: 18.3.1",
          "packages:",
          "  react@18.3.1: {}",
          "",
        ].join("\n"),
      },
    );
    const current = inspectedWorkspace(currentInspection, ".");

    await expect(
      resolveReactVersion(currentInspection, current),
    ).resolves.toEqual({ version: "18.3.1", source: "lockfile" });
  });

  it("uses one exact Bun direct version", async () => {
    const currentInspection = await inspectFixture(
      {
        packageManager: "bun@1.2.0",
        dependencies: { react: "^19.0.0" },
      },
      {
        "bun.lock": `{
          "lockfileVersion": 1,
          "packages": { "react": ["react@19.2.0"] }
        }`,
      },
    );
    const current = inspectedWorkspace(currentInspection, ".");

    await expect(
      resolveReactVersion(currentInspection, current),
    ).resolves.toEqual({ version: "19.2.0", source: "lockfile" });
  });

  it("ignores a lockfile version incompatible with the manifest", async () => {
    const currentInspection = await inspectFixture(
      { dependencies: { react: "^19.0.0" } },
      {
        "package-lock.json": {
          lockfileVersion: 3,
          packages: {
            "": {},
            "node_modules/react": { version: "18.3.1" },
          },
        },
      },
    );
    const current = inspectedWorkspace(currentInspection, ".");

    await expect(
      resolveReactVersion(currentInspection, current),
    ).resolves.toEqual({ version: "19.0.0", source: "manifest" });
  });

  it("ignores a non-semver exact-looking Bun version", async () => {
    const currentInspection = await inspectFixture(
      { packageManager: "bun@1.2.0", dependencies: { react: "*" } },
      {
        "bun.lock": `{
          "lockfileVersion": 1,
          "packages": { "react": ["react@latest"] }
        }`,
      },
    );
    const current = inspectedWorkspace(currentInspection, ".");

    await expect(
      resolveReactVersion(currentInspection, current),
    ).resolves.toEqual({ version: "0.0.0", source: "manifest" });
  });

  it("does not rescue an unsupported manifest alias from a lockfile", async () => {
    const currentInspection = await inspectFixture(
      { dependencies: { react: "npm:preact@10.27.0" } },
      {
        "package-lock.json": {
          lockfileVersion: 3,
          packages: {
            "": {},
            "node_modules/react": { version: "19.2.0" },
          },
        },
      },
    );
    const current = inspectedWorkspace(currentInspection, ".");

    await expect(
      resolveReactVersion(currentInspection, current),
    ).resolves.toEqual({ version: "19.2.0", source: "fallback" });
  });

  it("silently uses the manifest when a supported lockfile parser fails", async () => {
    const currentInspection = await inspectFixture(
      {
        packageManager: "pnpm@10.0.0",
        dependencies: { react: "^18.2.0" },
      },
      { "pnpm-lock.yaml": "lockfileVersion: '99.0'\npackages: {}\n" },
    );
    const current = inspectedWorkspace(currentInspection, ".");

    await expect(
      resolveReactVersion(currentInspection, current),
    ).resolves.toEqual({ version: "18.2.0", source: "manifest" });
  });
});
