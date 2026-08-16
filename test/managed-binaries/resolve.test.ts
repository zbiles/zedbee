import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveManagedBinary } from "../../src/managed-binaries/resolve.js";

const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "zedbee-managed-resolve-"));
  await mkdir(join(root, "vendor"));
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: "@zedbee/gitleaks-darwin-arm64", version: "0.0.0" }),
  );
  await writeFile(join(root, "vendor/gitleaks"), "fixture-executable");
  await chmod(join(root, "vendor/gitleaks"), 0o755);
  await writeFile(join(root, "vendor/gitleaks.toml"), "fixture-config");
  await writeFile(
    join(root, "manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      engine: "gitleaks",
      version: "8.28.0",
      platform: "darwin",
      arch: "arm64",
      executablePath: "vendor/gitleaks",
      executableSha256: sha256("fixture-executable"),
      configPath: "vendor/gitleaks.toml",
      configSha256: sha256("fixture-config"),
    }),
  );
  return root;
}

describe("resolveManagedBinary", () => {
  it("resolves a closed platform package and verified config", async () => {
    const root = await fixture();
    const binary = await resolveManagedBinary("gitleaks", "darwin", "arm64", {
      resolvePackageJson: async (specifier) => {
        expect(specifier).toBe("@zedbee/gitleaks-darwin-arm64/package.json");
        return pathToFileURL(join(root, "package.json")).href;
      },
    });

    expect(binary).toMatchObject({
      engine: "gitleaks",
      version: "8.28.0",
      platform: "darwin",
      arch: "arm64",
      packageName: "@zedbee/gitleaks-darwin-arm64",
      executableSha256: sha256("fixture-executable"),
      configSha256: sha256("fixture-config"),
    });
    expect(binary.executablePath).toBe(
      await realpath(join(root, "vendor/gitleaks")),
    );
    expect(binary.configPath).toBe(
      await realpath(join(root, "vendor/gitleaks.toml")),
    );
  });

  it("reports unsupported and absent platform packages generically", async () => {
    await expect(
      resolveManagedBinary("gitleaks", "aix", "ppc64"),
    ).rejects.toMatchObject({ code: "MANAGED_BINARY_UNAVAILABLE" });
    await expect(
      resolveManagedBinary("osv-scanner", "linux", "x64", {
        resolvePackageJson: async () => {
          throw new Error("sensitive resolver details");
        },
      }),
    ).rejects.toMatchObject({
      code: "MANAGED_BINARY_UNAVAILABLE",
      message: "Managed osv-scanner is unavailable for linux x64.",
    });
  });

  it("rejects a config whose bytes do not match its manifest", async () => {
    const root = await fixture();
    await writeFile(join(root, "vendor/gitleaks.toml"), "tampered");
    await expect(
      resolveManagedBinary("gitleaks", "darwin", "arm64", {
        resolvePackageJson: async () =>
          pathToFileURL(join(root, "package.json")).href,
      }),
    ).rejects.toMatchObject({ code: "MANAGED_BINARY_CHECKSUM_MISMATCH" });
  });
});
