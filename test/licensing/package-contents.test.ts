import { describe, expect, it } from "vitest";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptPath = fileURLToPath(
  new URL("../../scripts/check-package-contents.mjs", import.meta.url),
);

describe("package contents", () => {
  it("requires the legal artifacts and built CLI, entrypoint, and types", async () => {
    const { assertRequiredPackageFiles, REQUIRED_PACKAGE_FILES } =
      (await import(pathToFileURL(scriptPath).href)) as {
        assertRequiredPackageFiles(paths: readonly string[]): void;
        REQUIRED_PACKAGE_FILES: readonly string[];
      };
    const complete = [...REQUIRED_PACKAGE_FILES];

    expect(() => assertRequiredPackageFiles(complete)).not.toThrow();
    for (const required of REQUIRED_PACKAGE_FILES) {
      expect(() =>
        assertRequiredPackageFiles(
          complete.filter((path) => path !== required),
        ),
      ).toThrow(required);
    }
  });

  it("requires matching managed platform package artifacts and licenses", async () => {
    const { assertPlatformPackageArtifact } = (await import(
      pathToFileURL(scriptPath).href
    )) as {
      assertPlatformPackageArtifact(
        paths: readonly string[],
        packageJson: unknown,
        manifest: unknown,
      ): void;
    };
    const gitleaksManifest = {
      engine: "gitleaks",
      executablePath: "vendor/gitleaks",
      executableSha256: "a".repeat(64),
      configPath: "vendor/gitleaks.toml",
      configSha256: "b".repeat(64),
    };
    const complete = [
      "LICENSE",
      "THIRD_PARTY_NOTICES.md",
      "manifest.json",
      "package.json",
      "vendor/gitleaks",
      "vendor/gitleaks.toml",
    ];

    expect(() =>
      assertPlatformPackageArtifact(
        complete,
        { license: "MIT" },
        gitleaksManifest,
      ),
    ).not.toThrow();
    expect(() =>
      assertPlatformPackageArtifact(
        complete.filter((path) => path !== "manifest.json"),
        { license: "MIT" },
        gitleaksManifest,
      ),
    ).toThrow("manifest.json");
    expect(() =>
      assertPlatformPackageArtifact(
        [...complete, "src/downloader.ts"],
        { license: "MIT" },
        gitleaksManifest,
      ),
    ).toThrow("src/downloader.ts");
    expect(() =>
      assertPlatformPackageArtifact(
        complete,
        { license: "Apache-2.0" },
        gitleaksManifest,
      ),
    ).toThrow("MIT");
  });
});
