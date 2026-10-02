import { createHash } from "node:crypto";
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { dirname, join, posix } from "node:path";
import { satisfies } from "semver";

export const vendoredInventory = JSON.parse(
  readFileSync(
    new URL("./vendored-dependencies.json", import.meta.url),
    "utf8",
  ),
);
export const VENDORED_FILES = Object.freeze(
  vendoredInventory.packages.flatMap((entry) =>
    entry.files.map((file) => `${entry.destination}/${file.path}`),
  ),
);

export function assertVendoredDependencyLock(manifest, lockfile) {
  const pins = Object.fromEntries(
    vendoredInventory.packages.map((entry) => [entry.name, entry.version]),
  );
  if (JSON.stringify(manifest.vendoredDependencies) !== JSON.stringify(pins))
    throw new Error("Vendored dependencies must match the reviewed inventory.");
  for (const entry of vendoredInventory.packages) {
    const locked = lockfile.packages?.[entry.source];
    if (
      manifest.devDependencies?.[entry.name] !== entry.version ||
      manifest.dependencies?.[entry.name] !== undefined ||
      locked?.version !== entry.version ||
      locked?.integrity !== entry.integrity
    )
      throw new Error(
        `Vendored dependency does not match its pinned source: ${entry.name}`,
      );
    for (const [name, range] of Object.entries(locked.dependencies ?? {})) {
      const version = manifest.dependencies?.[name];
      if (typeof version !== "string" || !satisfies(version, range))
        throw new Error(
          `Vendored ${entry.name} needs a pinned runtime dependency: ${name}`,
        );
    }
  }
  // Native optional bindings must be installed for the consumer's platform.
  for (const name of ["oxc-parser", "oxc-resolver"])
    if (manifest.bundleDependencies?.includes(name))
      throw new Error(`Native dependency must not be bundled: ${name}`);
}

export function copyVendoredDependencies(root) {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const lockfile = JSON.parse(
    readFileSync(join(root, "package-lock.json"), "utf8"),
  );
  assertVendoredDependencyLock(manifest, lockfile);
  for (const entry of vendoredInventory.packages) {
    if (
      entry.source !== `node_modules/${entry.name}` ||
      entry.destination !== `dist/vendor/${entry.name}`
    )
      throw new Error("Invalid vendored package path.");
    for (const file of entry.files) {
      if (
        file.path.includes("\\") ||
        posix.isAbsolute(file.path) ||
        posix.normalize(file.path) !== file.path ||
        file.path.startsWith("../")
      )
        throw new Error("Invalid vendored file path.");
      const source = join(root, entry.source, file.path);
      if (
        !lstatSync(source).isFile() ||
        realpathSync(source) !== source ||
        createHash("sha256").update(readFileSync(source)).digest("hex") !==
          file.sha256
      )
        throw new Error(
          `Vendored source does not match the reviewed file: ${entry.name}/${file.path}`,
        );
      const destination = join(root, entry.destination, file.path);
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(source, destination);
    }
  }
}
