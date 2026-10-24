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

function safePackageName(name) {
  return (
    typeof name === "string" &&
    /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/iu.test(name)
  );
}

export function assertVendoredDependencyLock(
  manifest,
  lockfile,
  inventory = vendoredInventory,
) {
  const roots = inventory.packages.filter((entry) => entry.owner === undefined);
  const identities = new Set();
  for (const entry of inventory.packages) {
    const owner =
      entry.owner === undefined
        ? undefined
        : roots.find((root) => root.name === entry.owner);
    if (
      !safePackageName(entry.name) ||
      (entry.owner !== undefined && owner === undefined) ||
      entry.source !==
        (owner === undefined
          ? `node_modules/${entry.name}`
          : `${owner.source}/node_modules/${entry.name}`) ||
      entry.destination !==
        (owner === undefined
          ? `dist/vendor/${entry.name}`
          : `${owner.destination}/node_modules/${entry.name}`) ||
      identities.has(entry.destination)
    )
      throw new Error("Invalid vendored package path or owner.");
    identities.add(entry.destination);
  }
  const pins = Object.fromEntries(
    roots.map((entry) => [entry.name, entry.version]),
  );
  if (JSON.stringify(manifest.vendoredDependencies) !== JSON.stringify(pins))
    throw new Error("Vendored dependencies must match the reviewed inventory.");
  for (const entry of inventory.packages) {
    const locked = lockfile.packages?.[entry.source];
    if (
      (entry.owner === undefined &&
        (manifest.devDependencies?.[entry.name] !== entry.version ||
          manifest.dependencies?.[entry.name] !== undefined)) ||
      locked?.version !== entry.version ||
      locked?.integrity !== entry.integrity
    )
      throw new Error(
        `Vendored dependency does not match its pinned source: ${entry.name}`,
      );
    if (entry.owner !== undefined) {
      const owner = roots.find((root) => root.name === entry.owner);
      const range = lockfile.packages[owner.source]?.dependencies?.[entry.name];
      if (typeof range !== "string" || !satisfies(entry.version, range))
        throw new Error(
          `Private helper does not satisfy vendored ${entry.owner}: ${entry.name}`,
        );
    }
    for (const [name, range] of Object.entries(locked.dependencies ?? {})) {
      const privateHelper =
        entry.owner === undefined
          ? inventory.packages.find(
              (child) => child.owner === entry.name && child.name === name,
            )
          : undefined;
      const version = privateHelper?.version ?? manifest.dependencies?.[name];
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

export function copyVendoredDependencies(root, inventory = vendoredInventory) {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const lockfile = JSON.parse(
    readFileSync(join(root, "package-lock.json"), "utf8"),
  );
  assertVendoredDependencyLock(manifest, lockfile, inventory);
  for (const entry of inventory.packages) {
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
