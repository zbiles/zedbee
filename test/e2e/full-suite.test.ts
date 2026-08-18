import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { execa } from "execa";
import {
  releaseReadiness,
  verificationSteps,
} from "../../scripts/release-check.mjs";
import {
  assertAllowedPackageFiles,
  assertPackMetadata,
} from "../../scripts/check-package-contents.mjs";
import { releaseArtifactFilename } from "../../scripts/prepare-release-artifact.mjs";

const root = resolve(import.meta.dirname, "../..");

describe("release verification contract", () => {
  it("runs every local release-safety gate without requiring publication metadata", () => {
    expect(verificationSteps("verify").map(({ id }) => id)).toEqual([
      "typecheck",
      "tests",
      "build",
      "schema",
      "licenses",
      "benchmark",
      "package",
      "documentation",
      "diff",
    ]);
  });

  it("disables Git's pager for diff verification", () => {
    expect(verificationSteps("verify").find(({ id }) => id === "diff")).toEqual(
      {
        id: "diff",
        command: "git",
        args: ["--no-pager", "diff", "--check"],
      },
    );
  });

  it("blocks release while the package still has placeholder publication identity", () => {
    expect(releaseReadiness({ name: "zedbee", version: "0.0.0" }, [])).toEqual({
      ready: false,
      message:
        "Release blocked: package name, version, access, and registry must identify the public zedbee release.",
    });
  });

  it("accepts HTTPS metadata only when it identifies a configured Git remote", () => {
    expect(
      releaseReadiness(
        {
          name: "zedbee",
          version: "0.1.0",
          publishConfig: {
            access: "public",
            registry: "https://registry.npmjs.org/",
          },
          repository: { url: "https://github.com/owner/zedbee.git" },
          homepage: "https://github.com/owner/zedbee#readme",
          bugs: { url: "https://github.com/owner/zedbee/issues" },
        },
        ["git@github.com:owner/zedbee.git"],
      ),
    ).toEqual({ ready: true });
  });

  it.each([
    {
      repository: "https://github.com/owner/zedbee.evil",
      homepage: "https://github.com/owner/zedbee.evil#readme",
      bugs: "https://github.com/owner/zedbee.evil/issues",
      remote: "git@github.com:owner/zedbee.git",
    },
    {
      repository: "https://github.com/owner/zedbee",
      homepage: "https://github.com.evil/owner/zedbee#readme",
      bugs: "https://github.com/owner/zedbee/issues",
      remote: "git@github.com:owner/zedbee.git",
    },
    {
      repository: "https://github.com/owner/zedbee",
      homepage: "https://github.com/owner/zedbee.evil#readme",
      bugs: "https://github.com/owner/zedbee/issues",
      remote: "git@github.com:owner/zedbee.git",
    },
    {
      repository: "https://github.com/owner/zedbee",
      homepage: "https://github.com/owner/zedbee#readme",
      bugs: "https://github.com/owner/zedbee-security",
      remote: "git@github.com:owner/zedbee.git",
    },
  ])(
    "rejects repository siblings and lookalike origins: $homepage",
    ({ repository, homepage, bugs, remote }) => {
      expect(
        releaseReadiness(
          {
            name: "zedbee",
            version: "0.1.0",
            publishConfig: {
              access: "public",
              registry: "https://registry.npmjs.org/",
            },
            repository: { url: repository },
            homepage,
            bugs: { url: bugs },
          },
          [remote],
        ),
      ).toMatchObject({ ready: false });
    },
  );

  it("packs and inspects the Node-native core package", async () => {
    const result = await execa(
      process.execPath,
      [resolve(root, "scripts/check-package-contents.mjs")],
      { cwd: root, reject: false, stdin: "ignore" },
    );

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toBe("Core package contents passed.");
  }, 30_000);

  it.each([
    "docs/superpowers/plans/private.md",
    "PRODUCT.md",
    "test/fixture.ts",
    "src/internal.ts",
    "dist/unexpected-private-note.md",
    "dist/unexpected.js",
  ])("rejects an unapproved package path: %s", (unapproved) => {
    expect(() =>
      assertAllowedPackageFiles(["package.json", unapproved], {
        sourcePaths: ["src/index.ts"],
        reviewedOverridePaths: [],
      }),
    ).toThrow(/unapproved files/u);
  });

  it("accepts only declared public assets and source-derived build outputs", () => {
    expect(() =>
      assertAllowedPackageFiles(
        [
          "package.json",
          "README.md",
          "LICENSE",
          "THIRD_PARTY_NOTICES.md",
          "docs/support.md",
          "schema/zedbee.schema.json",
          "licenses/production-inventory.json",
          "licenses/reviewed-overrides.json",
          "licenses/reviewed-obligations.json",
          "licenses/overrides/example-LICENSE",
          "dist/index.js",
          "dist/index.js.map",
          "dist/index.d.ts",
          "dist/index.d.ts.map",
        ],
        {
          sourcePaths: ["src/index.ts"],
          reviewedOverridePaths: ["licenses/overrides/example-LICENSE"],
        },
      ),
    ).not.toThrow();
  });

  it("rejects bundled dependencies and mismatched pack identity", () => {
    expect(() =>
      assertPackMetadata(
        JSON.stringify([
          { name: "zedbee", version: "0.1.0", bundled: ["eslint"] },
        ]),
        "0.1.0",
      ),
    ).toThrow(/bundled dependencies/u);
    expect(() =>
      assertPackMetadata(
        JSON.stringify([{ name: "zedbee", version: "0.1.1", bundled: [] }]),
        "0.1.0",
      ),
    ).toThrow(/identity/u);
  });

  it("accepts only the canonical tarball emitted for the release manifest", () => {
    expect(
      releaseArtifactFilename(
        JSON.stringify([
          { name: "zedbee", version: "0.1.0", filename: "zedbee-0.1.0.tgz" },
        ]),
        { name: "zedbee", version: "0.1.0" },
      ),
    ).toBe("zedbee-0.1.0.tgz");

    for (const output of [
      JSON.stringify([
        { name: "zedbee", version: "0.1.0", filename: "../escape.tgz" },
      ]),
      JSON.stringify([
        { name: "other", version: "0.1.0", filename: "other-0.1.0.tgz" },
      ]),
      JSON.stringify([
        { name: "zedbee", version: "0.1.1", filename: "zedbee-0.1.1.tgz" },
      ]),
    ]) {
      expect(() =>
        releaseArtifactFilename(output, {
          name: "zedbee",
          version: "0.1.0",
        }),
      ).toThrow(/release artifact/u);
    }
  });

  it("uploads the smoke-tested tarball without publishing it", async () => {
    const workflow = await readFile(
      resolve(root, ".github/workflows/release-check.yml"),
      "utf8",
    );
    const prepare = workflow.indexOf("npm run artifact:prepare");
    const upload = workflow.indexOf("actions/upload-artifact@v4");

    expect(prepare).toBeGreaterThan(-1);
    expect(upload).toBeGreaterThan(prepare);
    expect(workflow).toContain("release-artifacts/*.tgz");
    expect(workflow).not.toMatch(/npm\s+publish/u);
  });
});
