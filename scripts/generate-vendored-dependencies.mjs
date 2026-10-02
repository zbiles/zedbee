import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { commandInvocation } from "./command-invocation.mjs";

const root = process.cwd();
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const lockfile = JSON.parse(
  readFileSync(join(root, "package-lock.json"), "utf8"),
);
const packages = [];
const temporaryCache = mkdtempSync(join(tmpdir(), "zedbee-vendor-cache-"));
try {
  for (const [name, version] of Object.entries(manifest.vendoredDependencies)) {
    const source = `node_modules/${name}`;
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
    packages.push({
      name,
      version,
      integrity: locked.integrity,
      source,
      destination: `dist/vendor/${name}`,
      files,
    });
  }
  writeFileSync(
    join(root, "scripts/vendored-dependencies.json"),
    `${JSON.stringify({ schemaVersion: 1, packages }, null, 2)}\n`,
  );
  process.stdout.write(
    `Reviewed vendor inventory generated (${packages.length} packages).\n`,
  );
} finally {
  rmSync(temporaryCache, { recursive: true, force: true });
}
