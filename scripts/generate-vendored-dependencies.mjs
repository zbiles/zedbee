import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { satisfies } from "semver";
import { commandInvocation } from "./command-invocation.mjs";
import { assertVendoredDependencyLock } from "./vendored-dependencies.mjs";

export function buildVendoredInventory(root) {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const lockfile = JSON.parse(
    readFileSync(join(root, "package-lock.json"), "utf8"),
  );
  const packages = [];
  const temporaryCache = mkdtempSync(join(tmpdir(), "zedbee-vendor-cache-"));
  try {
    const capture = (name, version, source, destination, owner) => {
      const installed = JSON.parse(
        readFileSync(join(root, source, "package.json"), "utf8"),
      );
      const locked = lockfile.packages[source];
      if (
        installed.name !== name ||
        installed.version !== version ||
        locked.version !== version ||
        !locked.integrity
      )
        throw new Error(`Vendored ${name} must match its locked installation.`);
      const invocation = commandInvocation("npm", [
        "pack",
        `./${source}`,
        "--json",
        "--ignore-scripts",
        "--dry-run",
      ]);
      const packed = spawnSync(invocation.executable, invocation.args, {
        cwd: root,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, npm_config_cache: temporaryCache },
      });
      if (packed.error) throw packed.error;
      if (packed.status !== 0) throw new Error(packed.stderr);
      const files = JSON.parse(packed.stdout)[0]
        .files.map(({ path }) => ({
          path,
          sha256: createHash("sha256")
            .update(readFileSync(join(root, source, path)))
            .digest("hex"),
        }))
        .sort((left, right) =>
          left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
        );
      const entry = {
        name,
        version,
        integrity: locked.integrity,
        source,
        destination,
        ...(owner === undefined ? {} : { owner }),
        files,
      };
      packages.push(entry);
      return entry;
    };
    for (const [name, version] of Object.entries(
      manifest.vendoredDependencies,
    )) {
      const entry = capture(
        name,
        version,
        `node_modules/${name}`,
        `dist/vendor/${name}`,
      );
      const locked = lockfile.packages[entry.source];
      for (const [dependency, range] of Object.entries(
        locked.dependencies ?? {},
      )) {
        if (satisfies(manifest.dependencies?.[dependency] ?? "", range))
          continue;
        const source = `${entry.source}/node_modules/${dependency}`;
        const nested = lockfile.packages[source];
        if (nested === undefined || !satisfies(nested.version, range))
          throw new Error(
            `Vendored ${name} cannot resolve its pinned helper: ${dependency}`,
          );
        capture(
          dependency,
          nested.version,
          source,
          `${entry.destination}/node_modules/${dependency}`,
          name,
        );
      }
    }
    const inventory = { schemaVersion: 1, packages };
    assertVendoredDependencyLock(manifest, lockfile, inventory);
    return inventory;
  } finally {
    rmSync(temporaryCache, { recursive: true, force: true });
  }
}

function main() {
  const root = process.cwd();
  const inventory = buildVendoredInventory(root);
  writeFileSync(
    join(root, "scripts/vendored-dependencies.json"),
    `${JSON.stringify(inventory, null, 2)}\n`,
  );
  process.stdout.write(
    `Reviewed vendor inventory generated (${inventory.packages.length} packages).\n`,
  );
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
)
  main();
