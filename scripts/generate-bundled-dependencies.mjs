import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandInvocation } from "./command-invocation.mjs";

// This is an explicit dependency-update step, never part of build or package
// checks. Review the resulting exact file inventory before accepting it.
const root = process.cwd();
const temporaryRoot = mkdtempSync(join(tmpdir(), "zedbee-bundled-inventory-"));
try {
  const invocation = commandInvocation("npm", [
    "pack",
    "--ignore-scripts",
    "--json",
    "--cache",
    join(temporaryRoot, "cache"),
    "--pack-destination",
    temporaryRoot,
  ]);
  const packed = spawnSync(invocation.executable, invocation.args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (packed.error !== undefined) throw packed.error;
  if (packed.status !== 0) throw new Error(packed.stderr || "npm pack failed");
  const record = JSON.parse(packed.stdout)[0];
  const lockfile = JSON.parse(
    readFileSync(join(root, "package-lock.json"), "utf8"),
  );
  const packagePaths = Object.keys(lockfile.packages)
    .filter((path) => path.startsWith("node_modules/"))
    .sort((left, right) => right.length - left.length);
  const packages = new Map();
  for (const { path } of record.files) {
    if (!path.startsWith("node_modules/")) continue;
    const packagePath = packagePaths.find((candidate) =>
      path.startsWith(`${candidate}/`),
    );
    if (packagePath === undefined)
      throw new Error(`Untracked bundled file: ${path}`);
    let entry = packages.get(packagePath);
    if (entry === undefined) {
      const installed = JSON.parse(
        readFileSync(join(root, packagePath, "package.json"), "utf8"),
      );
      const locked = lockfile.packages[packagePath];
      if (
        installed.version !== locked.version ||
        typeof locked.integrity !== "string"
      ) {
        throw new Error(
          `Bundled dependency does not match the lockfile: ${packagePath}`,
        );
      }
      entry = {
        path: packagePath,
        name: installed.name,
        version: installed.version,
        integrity: locked.integrity,
        files: [],
      };
      packages.set(packagePath, entry);
    }
    entry.files.push(path.slice(packagePath.length + 1));
  }
  const inventory = {
    schemaVersion: 1,
    packages: [...packages.values()].sort((left, right) =>
      left.path.localeCompare(right.path, "en"),
    ),
  };
  for (const entry of inventory.packages) entry.files.sort();
  writeFileSync(
    join(root, "scripts/bundled-dependencies.json"),
    `${JSON.stringify(inventory, null, 2)}\n`,
  );
  process.stdout.write(
    `Generated exact bundled file inventory (${inventory.packages.length} packages). Review before committing.\n`,
  );
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
