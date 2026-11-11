import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import semver from "semver";
import { isContainedPath } from "../../../inspection/read-json.js";
import { captureSnapshotRegistry } from "../../../inspection/snapshot-registry.js";
import { discoverWorkspaces } from "../../../inspection/workspaces.js";
import {
  ProjectEslintFailureError,
  type ProjectEslintInstallation,
} from "./types.js";

async function json(
  path: string,
  maxBytes = 1024 * 1024,
): Promise<Record<string, unknown>> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.size > maxBytes)
    throw new Error("Invalid manifest");
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Invalid manifest");
  return value as Record<string, unknown>;
}

/** Resolve only node_modules entries rooted inside this checkout; never Node's ancestor fallback. */
async function installed(
  root: string,
  projectRoot: string,
  name: string,
): Promise<{
  manifest: Record<string, unknown>;
  packageRoot: string;
  link: string;
}> {
  if (
    !/^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/iu.test(name) ||
    name === "." ||
    name === ".."
  )
    throw new ProjectEslintFailureError("PROJECT_ESLINT_INSTALL_INCONSISTENT");
  let context = resolve(root, projectRoot);
  while (isContainedPath(root, context)) {
    const physicalContext = await realpath(context).catch(() => undefined);
    if (
      physicalContext !== undefined &&
      !isContainedPath(root, physicalContext)
    )
      throw new ProjectEslintFailureError("PROJECT_ESLINT_LAYOUT_UNSUPPORTED");
    const candidate = join(context, "node_modules", name);
    try {
      const packageRoot = await realpath(candidate);
      return {
        manifest: await json(join(packageRoot, "package.json")),
        packageRoot,
        link: relative(root, candidate).split(sep).join("/"),
      };
    } catch {
      /* Try only the next hoisted level inside the checkout. */
    }
    if (context === root) break;
    context = dirname(context);
  }
  throw new ProjectEslintFailureError("PROJECT_ESLINT_INSTALL_MISSING");
}

export async function resolveProjectEslintInstallation(
  checkoutRoot: string,
  projectRoot: string,
  snapshotRoot: string,
): Promise<ProjectEslintInstallation> {
  try {
    const root = await realpath(checkoutRoot),
      snapshot = await realpath(snapshotRoot);
    const lock = await json(
      join(snapshot, "package-lock.json"),
      16 * 1024 * 1024,
    );
    if (
      ![2, 3].includes(lock.lockfileVersion as number) ||
      typeof lock.packages !== "object" ||
      lock.packages === null
    )
      throw new ProjectEslintFailureError(
        "PROJECT_ESLINT_INSTALL_INCONSISTENT",
      );
    const packages = lock.packages as Record<string, Record<string, unknown>>;
    const registry = await captureSnapshotRegistry(snapshot);
    const workspaces = await discoverWorkspaces(registry);
    const workspaceRoots = new Set(
      workspaces.map((workspace) => workspace.relativeRoot),
    );
    // The mirror reproduces workspace-level/hoisted installations. A nearer
    // undeclared node_modules in an imported config directory could otherwise
    // select different plugin bytes natively, then disappear from the mirror.
    for (const directory of registry
      .entries()
      .filter((entry) => entry.targetKind === "directory")) {
      if (workspaceRoots.has(directory.repositoryPath)) continue;
      const hasShadow = await lstat(
        join(root, directory.repositoryPath, "node_modules"),
      )
        .then(() => true)
        .catch(() => false);
      if (hasShadow)
        throw new ProjectEslintFailureError(
          "PROJECT_ESLINT_LAYOUT_UNSUPPORTED",
        );
    }
    let engineDeclared = false;
    for (const workspace of workspaces) {
      const manifestPath =
        workspace.relativeRoot === "." ? "" : workspace.relativeRoot;
      const lockedManifest = packages[manifestPath];
      for (const declaration of workspace.manifest.dependencyDeclarations) {
        const actual = await installed(
          root,
          workspace.relativeRoot,
          declaration.name,
        );
        const raw = packages[actual.link];
        const locked =
          raw?.link === true && typeof raw.resolved === "string"
            ? packages[raw.resolved]
            : raw;
        const declarations = lockedManifest?.[declaration.section] as
          Record<string, unknown> | undefined;
        const range = semver.validRange(declaration.specifier);
        const version = actual.manifest.version;
        const workspaceRange =
          declaration.specifier.startsWith("workspace:") && raw?.link === true;
        if (
          typeof version !== "string" ||
          locked?.version !== version ||
          declarations?.[declaration.name] !== declaration.specifier ||
          (range === null ? !workspaceRange : !semver.satisfies(version, range))
        )
          throw new ProjectEslintFailureError(
            "PROJECT_ESLINT_INSTALL_INCONSISTENT",
          );
        if (
          declaration.name === "eslint" &&
          (workspace.relativeRoot === "." ||
            workspace.relativeRoot === projectRoot ||
            projectRoot.startsWith(`${workspace.relativeRoot}/`))
        )
          engineDeclared = true;
      }
    }
    if (!engineDeclared)
      throw new ProjectEslintFailureError("PROJECT_ESLINT_INSTALL_MISSING");
    const engine = await installed(root, projectRoot, "eslint");
    if (engine.manifest.version !== "9.39.5")
      throw new ProjectEslintFailureError("PROJECT_ESLINT_VERSION_UNSUPPORTED");
    if (packages[engine.link]?.version !== engine.manifest.version)
      throw new ProjectEslintFailureError(
        "PROJECT_ESLINT_INSTALL_INCONSISTENT",
      );
    const entry = await realpath(join(engine.packageRoot, "lib/api.js"));
    if (
      !isContainedPath(engine.packageRoot, entry) ||
      !(await lstat(entry)).isFile()
    )
      throw new ProjectEslintFailureError(
        "PROJECT_ESLINT_INSTALL_INCONSISTENT",
      );
    return { entry, version: "9.39.5" };
  } catch (error) {
    if (error instanceof ProjectEslintFailureError) throw error;
    throw new ProjectEslintFailureError("PROJECT_ESLINT_INSTALL_INCONSISTENT");
  }
}
