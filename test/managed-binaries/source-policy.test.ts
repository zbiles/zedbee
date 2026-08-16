import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execute = promisify(execFile);
const policyUrl = new URL(
  "../../scripts/managed-binary-source-policy.mjs",
  import.meta.url,
).href;

async function validate(entry: Record<string, unknown>): Promise<void> {
  const source = `
    import { assertOfficialManagedBinaryEntry } from ${JSON.stringify(policyUrl)};
    assertOfficialManagedBinaryEntry(JSON.parse(process.argv[1]));
  `;
  await execute(process.execPath, [
    "--input-type=module",
    "--eval",
    source,
    JSON.stringify(entry),
  ]);
}

const official = {
  engine: "gitleaks",
  version: "8.28.0",
  platform: "linux",
  arch: "x64",
  packageName: "@zedbee/gitleaks-linux-x64",
  assetUrl:
    "https://github.com/gitleaks/gitleaks/releases/download/v8.28.0/gitleaks_8.28.0_linux_x64.tar.gz",
  checksumUrl:
    "https://github.com/gitleaks/gitleaks/releases/download/v8.28.0/gitleaks_8.28.0_checksums.txt",
  assetFormat: "tar.gz",
  executablePath: "vendor/gitleaks",
  licensePath: "LICENSE",
  noticePath: "THIRD_PARTY_NOTICES.md",
  configUrl:
    "https://raw.githubusercontent.com/gitleaks/gitleaks/v8.28.0/config/gitleaks.toml",
  configPath: "vendor/gitleaks.toml",
};

describe("managed binary source policy", () => {
  it("accepts only the exact reviewed release template", async () => {
    await expect(validate(official)).resolves.toBeUndefined();
  });

  it.each([
    {
      assetUrl:
        "https://github.com/attacker/gitleaks/releases/download/v8.28.0/gitleaks_8.28.0_linux_x64.tar.gz",
    },
    { version: "8.29.0" },
    {
      configUrl:
        "https://raw.githubusercontent.com/attacker/gitleaks/v8.28.0/config/gitleaks.toml",
    },
  ])("rejects a manifest-controlled trust-root change", async (change) => {
    await expect(validate({ ...official, ...change })).rejects.toThrow();
  });
});
