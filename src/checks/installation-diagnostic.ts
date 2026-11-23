import { posix } from "node:path";
import type {
  RepositoryInspection,
  WorkspaceInspection,
} from "../inspection/types.js";

export const INSTALLATION_MESSAGE =
  "This checkout cannot resolve a package required by the workspace's declared dependencies.";
export const INSTALLATION_CONTEXTUAL_PREFIX = "This checkout cannot resolve '";
export const INSTALLATION_REMEDIATION =
  "Restore dependencies in this checkout using the repository's package-manager instructions, then rerun the scan.";

/** Only final local reports receive identifiers. Review immutable declaration
 * context and the proposed labels before crossing the analyzer result boundary.
 * All heavy imports remain lazy, and failure withholds details. */
export async function reviewedInstallationLabels(
  inspection: RepositoryInspection,
  workspace: WorkspaceInspection,
  name: string,
  repositoryRoot: string,
): Promise<
  | Readonly<{ name: string; workspace: string; npmInstallRoot?: string }>
  | undefined
> {
  if (
    name.length > 214 ||
    !/^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/iu.test(name) ||
    workspace.relativeRoot.length > 512 ||
    !/^[a-z0-9._/-]+$/iu.test(workspace.relativeRoot)
  )
    return undefined;
  try {
    const related = inspection.workspaces.filter(
      (w) =>
        w.relativeRoot === "." ||
        w.relativeRoot === workspace.relativeRoot ||
        workspace.relativeRoot.startsWith(`${w.relativeRoot}/`),
    );
    const owners = related.filter((w) =>
      w.dependencyDeclarations.some((d) => d.name === name),
    );
    if (owners.length === 0 || related.length > 16) return undefined;
    const { capturedSourceRegistry } =
      await import("../inspection/source-capture.js");
    const { captureSnapshotRegistry } =
      await import("../inspection/snapshot-registry.js");
    const { readContainedFile } = await import("../inspection/read-json.js");
    const paths = owners.map((w) => w.manifestPath);
    const registry =
      capturedSourceRegistry(inspection.snapshotRoot, paths) ??
      (await captureSnapshotRegistry(inspection.snapshotRoot, paths));
    const { detectDiagnosticSecrets, diagnosticCredentialValues } =
      await import("./diagnostic-secret-review.js");
    const labels = `${name} ${workspace.relativeRoot}`;
    for (const path of paths) {
      const source = await readContainedFile(registry, path, {
        maxBytes: 64 * 1024,
      });
      const messages = await detectDiagnosticSecrets(source, path);
      for (const range of messages) {
        if (!range) return undefined;
        const value = source.slice(range[0], range[1]);
        if (!value || labels.includes(value)) return undefined;
      }
      for (const value of diagnosticCredentialValues(source))
        if (labels.includes(value)) return undefined;
    }
    const direct = await detectDiagnosticSecrets(labels, "diagnostic.txt");
    if (direct.length !== 0) return undefined;
    const npmInstallRoot = await reviewedNpmInstallRoot(
      inspection,
      workspace.relativeRoot,
      related,
      owners,
      repositoryRoot,
    ).catch(() => undefined);
    return {
      name,
      workspace: workspace.relativeRoot,
      ...(npmInstallRoot === undefined ? {} : { npmInstallRoot }),
    };
  } catch {
    return undefined;
  }
}

async function reviewedNpmInstallRoot(
  inspection: RepositoryInspection,
  target: string,
  related: readonly WorkspaceInspection[],
  owners: readonly WorkspaceInspection[],
  repositoryRoot: string,
): Promise<string | undefined> {
  const { capturedSourceRegistry } =
    await import("../inspection/source-capture.js");
  const { captureSnapshotRegistry } =
    await import("../inspection/snapshot-registry.js");
  const { readContainedFile } = await import("../inspection/read-json.js");
  const { parsePackageManifest, matchesWorkspacePattern } =
    await import("../inspection/workspaces.js");
  const pnpmControls = related.map(({ relativeRoot }) =>
    posix.join(relativeRoot, "pnpm-workspace.yaml"),
  );
  const paths = [
    ...related.map(({ manifestPath }) => manifestPath),
    ...pnpmControls,
  ];
  const registry =
    capturedSourceRegistry(inspection.snapshotRoot, paths) ??
    (await captureSnapshotRegistry(inspection.snapshotRoot, paths));
  // A pnpm workspace needs its own installation instructions, including in
  // checkouts with leftover npm lockfiles.
  if (pnpmControls.some((path) => registry.resolve(path) !== undefined))
    return undefined;
  const installs = await Promise.all(
    related.map(async (workspace) => ({
      root: workspace.relativeRoot,
      manifest: parsePackageManifest(
        JSON.parse(
          await readContainedFile(registry, workspace.manifestPath, {
            maxBytes: 64 * 1024,
          }),
        ),
        workspace.manifestPath,
      ),
      locks: inspection.lockfiles.filter(
        (path) => posix.dirname(path) === workspace.relativeRoot,
      ),
    })),
  );
  const shared = installs.filter(
    ({ root, manifest }) =>
      root !== target &&
      matchesWorkspacePattern(
        posix.relative(root, target),
        manifest.workspacePatterns,
      ),
  );
  if (shared.length > 1) return undefined;
  const selected =
    shared[0] ??
    (owners.length === 1
      ? installs.find(({ root }) => root === owners[0]!.relativeRoot)
      : undefined);
  if (
    selected === undefined ||
    selected.locks.length !== 1 ||
    !["package-lock.json", "npm-shrinkwrap.json"].includes(
      posix.basename(selected.locks[0]!),
    ) ||
    installs.some(
      ({ root, manifest, locks }) =>
        (root === selected.root ||
          root.startsWith(`${selected.root}/`) ||
          selected.root === ".") &&
        ((root !== selected.root && locks.length > 0) ||
          (manifest.packageManager !== undefined &&
            !/^npm@\d+\.\d+\.\d+(?:[-+][0-9a-z.+-]+)?$/iu.test(
              manifest.packageManager,
            ))),
    )
  )
    return undefined;

  if (
    selected.root !== "." &&
    !/^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/iu.test(selected.root)
  )
    return undefined;

  return (await liveInstallMetadataMatches(
    inspection.snapshotRoot,
    repositoryRoot,
    target,
    selected.locks[0]!,
  ))
    ? selected.root
    : undefined;
}

/** An install command acts on the working checkout, even for baseline errors. */
async function liveInstallMetadataMatches(
  snapshotRoot: string,
  repositoryRoot: string,
  target: string,
  selectedLock: string,
): Promise<boolean> {
  const { LOCKFILE_MANAGERS } =
    await import("../inspection/inspect-repository.js");
  const { captureSnapshotRegistry } =
    await import("../inspection/snapshot-registry.js");
  const { canonicalizeSnapshotRoot, readContainedFile } =
    await import("../inspection/read-json.js");
  const controls = new Map<string, number>();
  for (let root = target; ; root = posix.dirname(root)) {
    for (const name of ["package.json", ".npmrc", "pnpm-workspace.yaml"])
      controls.set(posix.join(root, name), 64 * 1024);
    for (const name of Object.keys(LOCKFILE_MANAGERS))
      controls.set(posix.join(root, name), 0);
    if (root === ".") break;
    if (controls.size > 144) return false;
  }
  controls.set(selectedLock, 8 * 1024 * 1024);
  const paths = [...controls.keys()];
  const [snapshot, live] = await Promise.all([
    captureSnapshotRegistry(snapshotRoot, paths),
    canonicalizeSnapshotRoot(repositoryRoot).then((root) =>
      captureSnapshotRegistry(root, paths),
    ),
  ]);
  if (snapshot.exact(selectedLock)?.kind !== "file") return false;
  for (const [path, maxBytes] of controls) {
    const before = snapshot.resolve(path);
    const current = live.resolve(path);
    if (
      snapshot.unavailableSymlinks?.has(path) === true ||
      live.unavailableSymlinks?.has(path) === true ||
      before?.kind !== current?.kind ||
      (before !== undefined && before.kind !== "file")
    )
      return false;
    if (before === undefined || maxBytes === 0) continue;
    const [expected, actual] = await Promise.all([
      readContainedFile(snapshot, path, { maxBytes }),
      readContainedFile(live, path, { maxBytes }),
    ]);
    if (expected !== actual) return false;
  }
  return true;
}
