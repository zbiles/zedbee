import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execa } from "execa";
import { expect, it } from "vitest";
import {
  installPackedFixture,
  sharedPackedTarball,
} from "../helpers/packed-install.js";

const root = resolve(import.meta.dirname, "../..");

it("preserves a consumer's locked Prettier and CLI when installing packed Zedbee", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "zedbee-prettier-isolation-"));
  try {
    const npmOptions = {
      cwd: scratch,
      stdin: "ignore" as const,
      env: { npm_config_cache: join(scratch, "npm-cache") },
    };
    const pack = async (directory: string): Promise<string> => {
      const packed = await execa(
        "npm",
        [
          "pack",
          directory,
          "--json",
          "--ignore-scripts",
          "--pack-destination",
          scratch,
        ],
        npmOptions,
      );
      const metadata = JSON.parse(packed.stdout) as Array<{ filename: string }>;
      return join(scratch, metadata[0]!.filename);
    };
    const tarball = sharedPackedTarball()?.path ?? (await pack(root));
    // A real older formatter with a compatible range reproduces npm's
    // replacement of a consumer lock entry by Zedbee's managed version.
    const olderPrettier = await pack(join(root, "node_modules/prettier-3-0-3"));
    await writeFile(
      join(scratch, "package.json"),
      '{"name":"consumer","private":true}\n',
    );
    await execa(
      "npm",
      [
        "install",
        "--save-dev",
        "--offline",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        olderPrettier,
      ],
      npmOptions,
    );
    const manifest = JSON.parse(
      await readFile(join(scratch, "package.json"), "utf8"),
    );
    const lock = JSON.parse(
      await readFile(join(scratch, "package-lock.json"), "utf8"),
    );
    manifest.devDependencies.prettier = "^3.0.0";
    manifest.devDependencies.zedbee = `file:${tarball}`;
    lock.packages[""].devDependencies.prettier = "^3.0.0";
    await writeFile(
      join(scratch, "package.json"),
      `${JSON.stringify(manifest)}\n`,
    );
    await writeFile(
      join(scratch, "package-lock.json"),
      `${JSON.stringify(lock)}\n`,
    );
    const before = lock.packages["node_modules/prettier"];
    expect(before.version).toBe("3.0.3");
    const version = async () =>
      (
        await execa(
          "npm",
          ["exec", "--offline", "--", "prettier", "--version"],
          npmOptions,
        )
      ).stdout;
    expect(await version()).toBe("3.0.3");

    await installPackedFixture(
      tarball,
      root,
      scratch,
      join(scratch, "install-cache"),
      {
        reuseSharedInstall: false,
      },
    );

    const installedLock = JSON.parse(
      await readFile(join(scratch, "package-lock.json"), "utf8"),
    );
    expect(installedLock.packages["node_modules/prettier"]).toEqual(before);
    expect(await version()).toBe("3.0.3");
    const managedRoot = join(
      scratch,
      "node_modules/zedbee/node_modules/prettier",
    );
    const managed = JSON.parse(
      await readFile(join(managedRoot, "package.json"), "utf8"),
    );
    expect(managed.version).toBe("3.9.6");
    const formatter = await import(
      pathToFileURL(join(managedRoot, "index.mjs")).href
    );
    expect(
      await formatter.format("const value:number=1", { parser: "typescript" }),
    ).toBe("const value: number = 1;\n");
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
