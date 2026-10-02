import { describe, expect, it } from "vitest";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptPath = fileURLToPath(
  new URL("../../scripts/check-package-contents.mjs", import.meta.url),
);

describe("package contents", () => {
  it("accepts the isolated managed formatter but rejects additional bundled packages", async () => {
    const { assertPackMetadata } = await import(pathToFileURL(scriptPath).href);
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
      assertPackMetadata(metadata(["prettier"]), "0.1.0"),
    ).not.toThrow();
    for (const bundled of [
      [],
      ["eslint"],
      ["prettier", "eslint"],
      ["prettier", "prettier"],
    ]) {
      expect(() => assertPackMetadata(metadata(bundled), "0.1.0")).toThrow(
        /bundled dependencies/u,
      );
    }
  });

  it("allows only reviewed managed Prettier files in the nested bundle", async () => {
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
        ],
        options,
      ),
    ).not.toThrow();
    for (const unapproved of [
      "node_modules/prettier/private-note.md",
      "node_modules/prettier/plugins/unreviewed.mjs",
      "node_modules/prettier/node_modules/unapproved/index.js",
      "node_modules/eslint/package.json",
    ]) {
      expect(() => assertAllowedPackageFiles([unapproved], options)).toThrow(
        /unapproved files/u,
      );
    }
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
