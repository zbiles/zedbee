import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");

async function json(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(resolve(root, path), "utf8")) as Record<
    string,
    unknown
  >;
}

describe("managed binary package manifests", () => {
  it("locks all ten supported engine/platform combinations", async () => {
    const manifest = await json("packages/managed-binary/manifest.json");
    const entries = manifest.entries as Array<Record<string, unknown>>;
    expect(entries).toHaveLength(10);
    expect(
      entries.map(
        ({ engine, platform, arch }) => `${engine}:${platform}:${arch}`,
      ),
    ).toEqual(
      [
        ...new Set(
          entries.map(
            ({ engine, platform, arch }) => `${engine}:${platform}:${arch}`,
          ),
        ),
      ].sort(),
    );

    for (const entry of entries) {
      expect(entry).toEqual(
        expect.objectContaining({
          engine: expect.stringMatching(/^(gitleaks|osv-scanner)$/),
          version: expect.any(String),
          assetUrl: expect.stringMatching(/^https:\/\/github\.com\//),
          assetSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          checksumUrl: expect.stringMatching(/^https:\/\/github\.com\//),
          checksumSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          executablePath: expect.stringMatching(/^vendor\//),
          executableSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          licensePath: "LICENSE",
          noticePath: "THIRD_PARTY_NOTICES.md",
        }),
      );
    }
  });

  it("uses exact optional dependencies and upstream license metadata", async () => {
    const rootPackage = await json("package.json");
    const optionalDependencies = rootPackage.optionalDependencies as Record<
      string,
      string
    >;
    expect(Object.keys(optionalDependencies)).toHaveLength(10);
    expect(new Set(Object.values(optionalDependencies))).toEqual(
      new Set(["0.0.0"]),
    );

    const central = await json("packages/managed-binary/manifest.json");
    for (const entry of central.entries as Array<Record<string, string>>) {
      const packageDirectory = entry.packageName!.replace("@zedbee/", "");
      const manifest = await json(`packages/${packageDirectory}/package.json`);
      expect(manifest.name).toBe(entry.packageName);
      expect(manifest.os).toEqual([entry.platform]);
      expect(manifest.cpu).toEqual([entry.arch]);
      expect(manifest.license).toBe(
        entry.engine === "gitleaks" ? "MIT" : "Apache-2.0",
      );
      expect(manifest.license).not.toBe("PolyForm-Small-Business-1.0.0");
      expect(manifest.files).toEqual(
        expect.arrayContaining([
          entry.executablePath,
          "LICENSE",
          "THIRD_PARTY_NOTICES.md",
          "manifest.json",
        ]),
      );

      const embedded = await json(`packages/${packageDirectory}/manifest.json`);
      expect(embedded).toMatchObject({
        engine: entry.engine,
        version: entry.version,
        platform: entry.platform,
        arch: entry.arch,
        executablePath: entry.executablePath,
        executableSha256: entry.executableSha256,
      });
    }
  });
});
