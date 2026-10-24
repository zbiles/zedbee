import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";

const script = (name: string) =>
  new URL(`../../scripts/${name}.mjs`, import.meta.url).href;

async function fixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "zedbee-private-vendor-")),
  );
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const manifest = {
    name: "vendor-fixture",
    version: "1.0.0",
    dependencies: { helper: "2.0.0" },
    devDependencies: { tool: "1.0.0" },
    vendoredDependencies: { tool: "1.0.0" },
  };
  const toolSource = "node_modules/tool";
  const helperSource = `${toolSource}/node_modules/helper`;
  const tool = {
    name: "tool",
    version: "1.0.0",
    dependencies: { helper: "1.0.0" },
  };
  for (const [path, metadata, source] of [
    [toolSource, tool, 'module.exports = require("helper");\n'],
    [
      helperSource,
      { name: "helper", version: "1.0.0" },
      'module.exports = "private-old";\n',
    ],
    [
      "node_modules/helper",
      { name: "helper", version: "2.0.0" },
      'module.exports = "public-new";\n',
    ],
  ] as const) {
    await mkdir(join(root, path), { recursive: true });
    await writeFile(join(root, path, "package.json"), JSON.stringify(metadata));
    await writeFile(join(root, path, "index.js"), source);
  }
  const lockfile = {
    name: manifest.name,
    version: manifest.version,
    lockfileVersion: 3,
    packages: {
      "": manifest,
      [toolSource]: { ...tool, integrity: "sha512-tool", dev: true },
      [helperSource]: {
        name: "helper",
        version: "1.0.0",
        integrity: "sha512-private",
        dev: true,
      },
      "node_modules/helper": {
        name: "helper",
        version: "2.0.0",
        integrity: "sha512-public",
      },
    },
  };
  await writeFile(join(root, "package.json"), JSON.stringify(manifest));
  await writeFile(join(root, "package-lock.json"), JSON.stringify(lockfile));
  const entry = async (name: string, source: string, owner?: string) => ({
    name,
    version:
      lockfile.packages[source as keyof typeof lockfile.packages].version,
    integrity: source === toolSource ? "sha512-tool" : "sha512-private",
    source,
    destination:
      owner === undefined
        ? `dist/vendor/${name}`
        : `dist/vendor/${owner}/node_modules/${name}`,
    ...(owner === undefined ? {} : { owner }),
    files: await Promise.all(
      ["index.js", "package.json"].map(async (path) => ({
        path,
        sha256: createHash("sha256")
          .update(await readFile(join(root, source, path)))
          .digest("hex"),
      })),
    ),
  });
  const inventory = {
    schemaVersion: 1,
    packages: [
      await entry("tool", toolSource),
      await entry("helper", helperSource, "tool"),
    ],
  };
  return { root, manifest, lockfile, inventory };
}

it("keeps an exact private helper when the public helper advances", async () => {
  const { root, manifest, lockfile, inventory } = await fixture();
  const { assertVendoredDependencyLock, copyVendoredDependencies } =
    await import(script("vendored-dependencies"));
  expect(() =>
    assertVendoredDependencyLock(manifest, lockfile, inventory),
  ).not.toThrow();
  copyVendoredDependencies(root, inventory);
  const require = createRequire(join(root, "package.json"));
  expect(require("helper")).toBe("public-new");
  expect(require(join(root, "dist/vendor/tool/index.js"))).toBe("private-old");
});

it("rejects missing, stale, unrelated and escaping private helper records", async () => {
  const { manifest, lockfile, inventory } = await fixture();
  const { assertVendoredDependencyLock } = await import(
    script("vendored-dependencies")
  );
  expect(() =>
    assertVendoredDependencyLock(manifest, lockfile, inventory),
  ).not.toThrow();
  const missing = structuredClone(inventory);
  missing.packages.pop();
  expect(() =>
    assertVendoredDependencyLock(manifest, lockfile, missing),
  ).toThrow();
  for (const update of [
    { version: "2.0.0" },
    { integrity: "sha512-unreviewed" },
    { owner: "other" },
    { name: "../helper" },
    { source: "node_modules/tool/../../helper" },
    { destination: "dist/vendor/tool/../../outside" },
  ]) {
    const modified = structuredClone(inventory);
    Object.assign(modified.packages[1]!, update);
    expect(() =>
      assertVendoredDependencyLock(manifest, lockfile, modified),
    ).toThrow();
  }
});

it("refuses modified or path-escaping private helper files before copying them", async () => {
  const { root, inventory } = await fixture();
  const { copyVendoredDependencies } = await import(
    script("vendored-dependencies")
  );
  await writeFile(
    join(root, "node_modules/tool/node_modules/helper/index.js"),
    'module.exports = "tampered";',
  );
  expect(() => copyVendoredDependencies(root, inventory)).toThrow(
    /reviewed file/u,
  );
  const escaping = structuredClone(inventory);
  escaping.packages[1]!.files[0]!.path = "../outside";
  expect(() => copyVendoredDependencies(root, escaping)).toThrow(/file path/u);
});

it("generates a reviewed private helper from the installed dependency resolution", async () => {
  const { root, manifest, lockfile } = await fixture();
  const { buildVendoredInventory } = await import(
    script("generate-vendored-dependencies")
  );
  const { assertVendoredDependencyLock, copyVendoredDependencies } =
    await import(script("vendored-dependencies"));
  const inventory = buildVendoredInventory(root);
  expect(inventory.packages).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        name: "helper",
        version: "1.0.0",
        owner: "tool",
        source: "node_modules/tool/node_modules/helper",
        destination: "dist/vendor/tool/node_modules/helper",
      }),
    ]),
  );
  expect(() =>
    assertVendoredDependencyLock(manifest, lockfile, inventory),
  ).not.toThrow();
  copyVendoredDependencies(root, inventory);
  expect(
    createRequire(join(root, "package.json"))(
      join(root, "dist/vendor/tool/index.js"),
    ),
  ).toBe("private-old");
});
