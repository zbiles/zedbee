import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execa } from "execa";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
let scratch: string;

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "zedbee-platform-packages-"));
});

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe("managed platform tarballs", () => {
  it("packs only executable, config, manifest, package metadata, and legal files", async () => {
    const { assertPlatformPackageArtifact } = (await import(
      pathToFileURL(resolve(root, "scripts/check-package-contents.mjs")).href
    )) as {
      assertPlatformPackageArtifact(
        paths: readonly string[],
        packageJson: unknown,
        manifest: unknown,
      ): void;
    };
    const central = JSON.parse(
      await readFile(
        resolve(root, "packages/managed-binary/manifest.json"),
        "utf8",
      ),
    ) as {
      entries: Array<{
        packageName: string;
        executablePath: string;
        configPath?: string;
      }>;
    };
    for (const entry of central.entries) {
      const directory = entry.packageName.replace("@zedbee/", "");
      const source = resolve(root, "packages", directory);
      const fixture = resolve(scratch, directory);
      await mkdir(fixture, { recursive: true });
      for (const file of [
        "package.json",
        "manifest.json",
        "LICENSE",
        "THIRD_PARTY_NOTICES.md",
      ]) {
        await cp(resolve(source, file), resolve(fixture, file));
      }
      const artifacts = [entry.executablePath, entry.configPath].filter(
        (path): path is string => path !== undefined,
      );
      for (const artifact of artifacts) {
        await mkdir(resolve(fixture, dirname(artifact)), { recursive: true });
        await writeFile(
          resolve(fixture, artifact),
          `fixture ${basename(artifact)}\n`,
        );
      }
      const packed = await execa(
        "npm",
        ["pack", "--dry-run", "--json", "--ignore-scripts"],
        {
          cwd: fixture,
          env: { npm_config_cache: resolve(scratch, "npm-cache") },
          reject: false,
          stdin: "ignore",
        },
      );
      expect(packed.exitCode, packed.stderr).toBe(0);
      const output = JSON.parse(packed.stdout) as Array<{
        files: Array<{ path: string }>;
      }>;
      const packageJson = JSON.parse(
        await readFile(resolve(fixture, "package.json"), "utf8"),
      ) as unknown;
      const manifest = JSON.parse(
        await readFile(resolve(fixture, "manifest.json"), "utf8"),
      ) as unknown;
      expect(() =>
        assertPlatformPackageArtifact(
          output[0]!.files.map(({ path }) => path),
          packageJson,
          manifest,
        ),
      ).not.toThrow();
    }
  }, 30_000);
});
