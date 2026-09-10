import { describe, expect, it } from "vitest";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptPath = fileURLToPath(
  new URL("../../scripts/check-package-contents.mjs", import.meta.url),
);

describe("package contents", () => {
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
