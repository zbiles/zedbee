import { readdir, readFile, realpath } from "node:fs/promises";
import {
  dirname,
  isAbsolute,
  join,
  posix,
  relative,
  resolve,
  sep,
} from "node:path";

function compareText(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function packageLabel(name, version) {
  return `${name ?? "unknown"}@${version ?? "unknown"}`;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafePackagePath(packagePath, allowRoot = false) {
  if (packagePath === "") return allowRoot;
  return (
    typeof packagePath === "string" &&
    !packagePath.includes("\\") &&
    !packagePath.includes("\0") &&
    !packagePath.startsWith("/") &&
    !/^[A-Za-z]:/.test(packagePath) &&
    posix.normalize(packagePath) === packagePath &&
    packagePath !== ".." &&
    !packagePath.startsWith("../")
  );
}

function assertSafePackagePath(packagePath, allowRoot = false) {
  if (!isSafePackagePath(packagePath, allowRoot)) {
    throw new Error(
      `unsafe package-lock.json path: ${JSON.stringify(packagePath)}`,
    );
  }
}

function isSafeDependencyName(name) {
  if (typeof name !== "string" || name.includes("\\") || name.includes("\0"))
    return false;
  const parts = name.split("/");
  if (name.startsWith("@")) {
    return (
      parts.length === 2 &&
      parts[0].length > 1 &&
      parts[1].length > 0 &&
      parts.every((part) => part !== "." && part !== "..")
    );
  }
  return (
    parts.length === 1 &&
    parts[0] !== "" &&
    parts[0] !== "." &&
    parts[0] !== ".."
  );
}

function validateDependencyMap(packagePath, field, value) {
  if (value === undefined) return;
  if (!isRecord(value)) {
    throw new Error(
      `invalid package-lock.json ${field} for ${packagePath || "the root package"}`,
    );
  }
  for (const [name, version] of Object.entries(value)) {
    if (!isSafeDependencyName(name)) {
      throw new Error(
        `unsafe package-lock.json path: dependency ${JSON.stringify(name)}`,
      );
    }
    if (typeof version !== "string") {
      throw new Error(
        `invalid package-lock.json ${field} entry ${JSON.stringify(name)} for ${
          packagePath || "the root package"
        }`,
      );
    }
  }
}

function validateLockfile(lockfile) {
  if (!isRecord(lockfile) || lockfile.lockfileVersion !== 3) {
    throw new Error("package-lock.json must use lockfileVersion 3");
  }
  if (!isRecord(lockfile.packages) || !isRecord(lockfile.packages[""])) {
    throw new Error(
      "package-lock.json must contain an object-valued packages root entry",
    );
  }

  for (const [packagePath, packageMetadata] of Object.entries(
    lockfile.packages,
  )) {
    assertSafePackagePath(packagePath, true);
    if (!isRecord(packageMetadata)) {
      throw new Error(
        `invalid package-lock.json package record: ${packagePath}`,
      );
    }
    validateDependencyMap(
      packagePath,
      "dependencies",
      packageMetadata.dependencies,
    );
    validateDependencyMap(
      packagePath,
      "optionalDependencies",
      packageMetadata.optionalDependencies,
    );
    validateDependencyMap(
      packagePath,
      "peerDependencies",
      packageMetadata.peerDependencies,
    );

    if (
      packageMetadata.peerDependenciesMeta !== undefined &&
      !isRecord(packageMetadata.peerDependenciesMeta)
    ) {
      throw new Error(
        `invalid package-lock.json peerDependenciesMeta for ${packagePath || "the root package"}`,
      );
    }
    if (packageMetadata.link === true) {
      assertSafePackagePath(packageMetadata.resolved);
      if (!Object.hasOwn(lockfile.packages, packageMetadata.resolved)) {
        throw new Error(
          `package-lock.json link ${packagePath} cannot resolve ${packageMetadata.resolved}`,
        );
      }
    }
  }
}

function dependencyEntries(packageMetadata) {
  const required = Object.keys(packageMetadata.dependencies ?? {}).map(
    (name) => ({
      name,
      optional: false,
    }),
  );
  const peers = Object.keys(packageMetadata.peerDependencies ?? {})
    .filter(
      (name) => packageMetadata.peerDependenciesMeta?.[name]?.optional !== true,
    )
    .map((name) => ({ name, optional: false }));
  const optional = Object.keys(packageMetadata.optionalDependencies ?? {}).map(
    (name) => ({
      name,
      optional: true,
    }),
  );
  const entries = new Map();

  for (const dependency of required) entries.set(dependency.name, dependency);
  for (const dependency of peers) entries.set(dependency.name, dependency);
  for (const dependency of optional) entries.set(dependency.name, dependency);

  return [...entries.values()].sort((left, right) =>
    compareText(left.name, right.name),
  );
}

function followPackageLinks(packages, initialPackagePath) {
  let packagePath = initialPackagePath;
  const visited = new Set();

  while (packages[packagePath].link === true) {
    if (visited.has(packagePath)) {
      throw new Error(
        `package-lock.json contains a link cycle at ${packagePath}`,
      );
    }
    visited.add(packagePath);
    packagePath = packages[packagePath].resolved;
  }

  return { packagePath, packageMetadata: packages[packagePath] };
}

function resolveDependencyPackagePath(
  packages,
  parentPackagePath,
  dependencyName,
) {
  let searchPath = parentPackagePath;

  while (true) {
    const candidate = searchPath
      ? `${searchPath}/node_modules/${dependencyName}`
      : `node_modules/${dependencyName}`;
    if (Object.hasOwn(packages, candidate)) return candidate;
    if (searchPath === "") return undefined;

    const nestedNodeModules = searchPath.lastIndexOf("/node_modules/");
    searchPath =
      nestedNodeModules === -1 ? "" : searchPath.slice(0, nestedNodeModules);
  }
}

export function findProductionDependencies(lockfile) {
  validateLockfile(lockfile);
  const packages = lockfile.packages;
  const rootPackage = packages?.[""];

  const rootLabel = packageLabel(
    rootPackage.name ?? lockfile.name,
    rootPackage.version ?? lockfile.version,
  );
  const queue = dependencyEntries(rootPackage).map((dependency) => ({
    parentPackagePath: "",
    dependency,
    dependencyPath: [rootLabel],
    optional: dependency.optional,
  }));
  const visited = new Set();
  const reachable = [];

  while (queue.length > 0) {
    const current = queue.shift();
    const packagePath = resolveDependencyPackagePath(
      packages,
      current.parentPackagePath,
      current.dependency.name,
    );
    if (packagePath === undefined) {
      if (current.optional) continue;
      throw new Error(
        `package-lock.json cannot resolve ${current.dependency.name} from ${
          current.parentPackagePath || "the root package"
        }`,
      );
    }
    const resolvedPackage = followPackageLinks(packages, packagePath);
    if (visited.has(resolvedPackage.packagePath)) continue;

    visited.add(resolvedPackage.packagePath);
    const packageMetadata = resolvedPackage.packageMetadata;
    const label = packageLabel(
      packageMetadata.name ?? current.dependency.name,
      packageMetadata.version,
    );
    const dependencyPath = [...current.dependencyPath, label];
    const optional = current.optional || packageMetadata.optional === true;
    reachable.push({
      packagePath: resolvedPackage.packagePath,
      dependencyPath,
      optional,
    });

    for (const dependency of dependencyEntries(packageMetadata)) {
      queue.push({
        parentPackagePath: resolvedPackage.packagePath,
        dependency,
        dependencyPath,
        optional: optional || dependency.optional,
      });
    }
  }

  return reachable.sort((left, right) =>
    compareText(left.packagePath, right.packagePath),
  );
}

function isLicenseFilename(filename) {
  return /^(?:licen[cs]e|copying|notice)(?:[.\-_]|$)/i.test(filename);
}

function portableRelativePath(root, target) {
  return relative(root, target).split(sep).join("/");
}

function assertContainedPath(root, target, sourcePath) {
  const fromRoot = relative(root, target);
  if (
    fromRoot === ".." ||
    fromRoot.startsWith(`..${sep}`) ||
    isAbsolute(fromRoot)
  ) {
    throw new Error(
      `unsafe package-lock.json path: ${JSON.stringify(sourcePath)}`,
    );
  }
}

function lexicalPackageDirectory(root, packagePath) {
  assertSafePackagePath(packagePath);
  const packageDirectory = resolve(root, ...packagePath.split("/"));
  assertContainedPath(root, packageDirectory, packagePath);
  return packageDirectory;
}

async function resolvePackageDirectory(root, packagePath) {
  const lexicalDirectory = lexicalPackageDirectory(root, packagePath);
  const packageJsonPath = join(lexicalDirectory, "package.json");
  const resolvedPackageJsonPath = await realpath(packageJsonPath);
  const packageDirectory = await realpath(lexicalDirectory);
  assertContainedPath(root, packageDirectory, packagePath);
  assertContainedPath(
    root,
    resolvedPackageJsonPath,
    `${packagePath}/package.json`,
  );
  return { packageDirectory, packageJsonPath: resolvedPackageJsonPath };
}

async function findLegalFiles(root, packageDirectory) {
  const entries = await readdir(packageDirectory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && isLicenseFilename(entry.name))
    .map((entry) => entry.name)
    .sort(compareText)
    .map((filename) =>
      portableRelativePath(root, join(packageDirectory, filename)),
    );
}

async function readLockfile(root) {
  const lockfilePath = join(root, "package-lock.json");
  let source;
  try {
    const resolvedLockfilePath = await realpath(lockfilePath);
    assertContainedPath(root, resolvedLockfilePath, "package-lock.json");
    source = await readFile(resolvedLockfilePath, "utf8");
  } catch (error) {
    throw new Error(`unable to read package-lock.json: ${error.message}`, {
      cause: error,
    });
  }

  try {
    return JSON.parse(source);
  } catch (error) {
    throw new Error(`invalid package-lock.json JSON: ${error.message}`, {
      cause: error,
    });
  }
}

export async function buildProductionInventory(root) {
  const canonicalRoot = await realpath(root);
  const lockfile = await readLockfile(canonicalRoot);
  const reachable = findProductionDependencies(lockfile);
  const inventoryPackages = [];

  for (const dependency of reachable) {
    let packageMetadata;
    let packageDirectory;
    try {
      const resolvedPackage = await resolvePackageDirectory(
        canonicalRoot,
        dependency.packagePath,
      );
      packageDirectory = resolvedPackage.packageDirectory;
      packageMetadata = JSON.parse(
        await readFile(resolvedPackage.packageJsonPath, "utf8"),
      );
    } catch (error) {
      if (dependency.optional && error?.code === "ENOENT") continue;
      throw error;
    }

    const legalFiles = await findLegalFiles(canonicalRoot, packageDirectory);
    inventoryPackages.push({
      name: packageMetadata.name ?? null,
      version: packageMetadata.version ?? null,
      license: packageMetadata.license ?? null,
      repository: packageMetadata.repository ?? null,
      licenseFile: legalFiles[0] ?? null,
      legalFiles,
      dependencyPath: dependency.dependencyPath,
    });
  }

  inventoryPackages.sort(
    (left, right) =>
      compareText(left.name ?? "", right.name ?? "") ||
      compareText(left.version ?? "", right.version ?? "") ||
      compareText(
        left.dependencyPath.join("\u0000"),
        right.dependencyPath.join("\u0000"),
      ),
  );

  return { schemaVersion: 1, packages: inventoryPackages };
}
