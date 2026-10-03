import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptPath = fileURLToPath(
  new URL("../../scripts/check-package-contents.mjs", import.meta.url),
);

describe("package contents", () => {
  it("requires the pinned vendor source and portable native dependency edges", async () => {
    const { assertVendoredDependencyLock } = await import(
      new URL("../../scripts/vendored-dependencies.mjs", import.meta.url).href
    );
    const manifest = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    );
    const lockfile = JSON.parse(
      readFileSync(new URL("../../package-lock.json", import.meta.url), "utf8"),
    );
    expect(() =>
      assertVendoredDependencyLock(manifest, lockfile),
    ).not.toThrow();
    for (const update of [
      { dependencies: { ...manifest.dependencies, knip: "6.32.2" } },
      {
        dependencies: {
          ...manifest.dependencies,
          "strip-json-comments": "3.1.1",
        },
      },
      { vendoredDependencies: {} },
      { bundleDependencies: [...manifest.bundleDependencies, "oxc-parser"] },
      { bundleDependencies: [...manifest.bundleDependencies, "oxc-resolver"] },
    ])
      expect(() =>
        assertVendoredDependencyLock({ ...manifest, ...update }, lockfile),
      ).toThrow();
    const stale = structuredClone(lockfile);
    stale.packages["node_modules/knip"].integrity = "sha512-unreviewed";
    expect(() => assertVendoredDependencyLock(manifest, stale)).toThrow(
      /pinned source/u,
    );
  });
  it("accepts the isolated managed engines but rejects additional bundled packages", async () => {
    const { assertPackMetadata, BUNDLED_PACKAGE_NAMES } = await import(
      pathToFileURL(scriptPath).href
    );
    const metadata = (bundled: string[]) =>
      JSON.stringify([
        {
          name: "zedbee",
          version: "0.1.0",
          bundled,
          files: [{ path: "dist/cli.js", mode: 0o755 }],
        },
      ]);
    expect(() =>
      assertPackMetadata(
        metadata([...BUNDLED_PACKAGE_NAMES].reverse()),
        "0.1.0",
      ),
    ).not.toThrow();
    for (const bundled of [
      [],
      ["eslint"],
      ["prettier", "eslint"],
      ["prettier", "prettier"],
      [...BUNDLED_PACKAGE_NAMES, "unapproved"],
      [...BUNDLED_PACKAGE_NAMES, "typescript"],
      BUNDLED_PACKAGE_NAMES.filter((name: string) => name !== "typescript"),
      BUNDLED_PACKAGE_NAMES.filter(
        (name: string) => name !== "dependency-cruiser",
      ),
    ]) {
      expect(() => assertPackMetadata(metadata(bundled), "0.1.0")).toThrow(
        /bundled dependencies/u,
      );
    }
  });

  it("allows only exact reviewed managed engine files in the nested bundle", async () => {
    const { assertAllowedPackageFiles } = await import(
      pathToFileURL(scriptPath).href
    );
    const options = {
      sourcePaths: ["src/index.ts"],
      reviewedOverridePaths: [],
    };
    expect(() =>
      assertAllowedPackageFiles(
        [
          "node_modules/prettier/package.json",
          "node_modules/prettier/LICENSE",
          "node_modules/prettier/THIRD-PARTY-NOTICES.md",
          "node_modules/prettier/index.mjs",
          "node_modules/prettier/plugins/typescript.mjs",
          "node_modules/typescript/lib/typescript.js",
          "node_modules/dependency-cruiser/src/main/index.mjs",
          "node_modules/typescript-eslint/dist/index.js",
          "node_modules/@typescript-eslint/parser/dist/index.js",
          "dist/vendor/knip/dist/index.js",
          "dist/vendor/knip/LICENSE",
        ],
        options,
      ),
    ).not.toThrow();
    for (const unapproved of [
      "node_modules/prettier/private-note.md",
      "node_modules/prettier/plugins/unreviewed.mjs",
      "node_modules/prettier/node_modules/unapproved/index.js",
      "node_modules/eslint/package.json",
      "node_modules/typescript/private-note.md",
      "node_modules/dependency-cruiser/src/private-note.md",
      "node_modules/@typescript-eslint/parser/dist/unreviewed.js",
      "node_modules/typescript-eslint/node_modules/typescript/lib/typescript.js",
      "dist/vendor/knip/private-note.md",
      "node_modules/oxc-parser/package.json",
    ]) {
      expect(() => assertAllowedPackageFiles([unapproved], options)).toThrow(
        /unapproved files/u,
      );
    }
  });

  it("rejects stale bundle versions, integrity, and managed dependency pins", async () => {
    const { assertBundledDependencyLock } = await import(
      pathToFileURL(scriptPath).href
    );
    const manifest = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    );
    const lockfile = JSON.parse(
      readFileSync(new URL("../../package-lock.json", import.meta.url), "utf8"),
    );
    expect(() => assertBundledDependencyLock(manifest, lockfile)).not.toThrow();
    for (const update of [
      { version: "0.0.0" },
      { integrity: "sha512-unreviewed" },
    ]) {
      const modified = structuredClone(lockfile);
      Object.assign(
        modified.packages["node_modules/@typescript-eslint/parser"],
        update,
      );
      expect(() => assertBundledDependencyLock(manifest, modified)).toThrow(
        /inventory does not match/u,
      );
    }
    expect(() =>
      assertBundledDependencyLock(
        {
          ...manifest,
          dependencies: { ...manifest.dependencies, typescript: "^6.0.3" },
        },
        lockfile,
      ),
    ).toThrow(/pinned managed dependency/u);
    expect(() =>
      assertBundledDependencyLock(
        { ...manifest, bundleDependencies: ["prettier", "typescript"] },
        lockfile,
      ),
    ).toThrow(/must bundle/u);
    expect(() =>
      assertBundledDependencyLock(
        {
          ...manifest,
          bundleDependencies: [...manifest.bundleDependencies, "eslint"],
        },
        lockfile,
      ),
    ).toThrow(/must bundle/u);
  });

  it.each(["SECURITY.md", "DISCLOSURE"])(
    "rejects a package missing %s",
    async (required) => {
      const { assertRequiredPackageFiles, REQUIRED_PACKAGE_FILES } =
        await import(pathToFileURL(scriptPath).href);
      expect(() =>
        assertRequiredPackageFiles(
          REQUIRED_PACKAGE_FILES.filter((path: string) => path !== required),
        ),
      ).toThrow(required);
    },
  );

  it("requires the legal artifacts and built CLI, entrypoint, and types", async () => {
    const { assertRequiredPackageFiles, REQUIRED_PACKAGE_FILES } =
      (await import(pathToFileURL(scriptPath).href)) as {
        assertRequiredPackageFiles(paths: readonly string[]): void;
        REQUIRED_PACKAGE_FILES: readonly string[];
      };
    const complete = [...REQUIRED_PACKAGE_FILES];

    expect(REQUIRED_PACKAGE_FILES).toContain("docs/managed-fixes.md");
    expect(REQUIRED_PACKAGE_FILES).toContain("docs/cli-reference.md");
    expect(() => assertRequiredPackageFiles(complete)).not.toThrow();
    for (const required of REQUIRED_PACKAGE_FILES) {
      expect(() =>
        assertRequiredPackageFiles(
          complete.filter((path) => path !== required),
        ),
      ).toThrow(required);
    }
  });
});
