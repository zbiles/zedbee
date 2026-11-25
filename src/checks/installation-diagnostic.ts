import type {
  RepositoryInspection,
  WorkspaceInspection,
} from "../inspection/types.js";

export const INSTALLATION_MESSAGE =
  "Analysis is incomplete because a package required by this workspace's declared dependencies is unavailable. Installation prerequisites could not be verified.";
export const INSTALLATION_REMEDIATION =
  "Install this workspace's declared dependencies using its package manager and rerun the scan.";

/** Only final local reports receive identifiers. Review immutable declaration
 * context and the proposed labels before crossing the analyzer result boundary.
 * All heavy imports remain lazy, and failure withholds details. */
export async function reviewedInstallationLabels(
  inspection: RepositoryInspection,
  workspace: WorkspaceInspection,
  name: string,
): Promise<Readonly<{ name: string; workspace: string }> | undefined> {
  if (
    name.length > 214 ||
    !/^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/iu.test(name) ||
    workspace.relativeRoot.length > 512 ||
    !/^[a-z0-9._/-]+$/iu.test(workspace.relativeRoot)
  )
    return undefined;
  try {
    const owners = inspection.workspaces.filter(
      (w) =>
        (w.relativeRoot === "." ||
          w.relativeRoot === workspace.relativeRoot ||
          workspace.relativeRoot.startsWith(`${w.relativeRoot}/`)) &&
        w.dependencyDeclarations.some((d) => d.name === name),
    );
    if (owners.length === 0 || owners.length > 16) return undefined;
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
    return direct.length === 0
      ? { name, workspace: workspace.relativeRoot }
      : undefined;
  } catch {
    return undefined;
  }
}
