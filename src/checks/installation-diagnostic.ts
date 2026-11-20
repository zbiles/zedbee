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
    const { readContainedFile } =
      await import("../inspection/read-json.js");
    const paths = owners.map((w) => w.manifestPath);
    const registry =
      capturedSourceRegistry(inspection.snapshotRoot, paths) ??
      (await captureSnapshotRegistry(inspection.snapshotRoot, paths));
    const { lintSource } = await import("@secretlint/core");
    const { SECRET_LINT_CONFIG } = await import("./secrets/config.js");
    const labels = `${name} ${workspace.relativeRoot}`;
    for (const path of paths) {
      const source = await readContainedFile(registry, path, {
        maxBytes: 64 * 1024,
      });
      const result = await lintSource({
        source: { content: source, filePath: path, contentType: "text" },
        options: {
          config: SECRET_LINT_CONFIG,
          maskSecrets: true,
          noPhysicFilePath: true,
        },
      });
      for (const message of result.messages) {
        if (!message.range) return undefined;
        const value = source.slice(message.range[0], message.range[1]);
        if (!value || labels.includes(value)) return undefined;
      }
      for (const match of source.matchAll(
        /(?:secret|password|token|credential|api[_-]?key|access[_-]?key)[\w-]*["']?\s*[:=]\s*["']([^"'\r\n]+)["']/giu,
      ))
        if (match[1] && labels.includes(match[1])) return undefined;
    }
    const direct = await lintSource({
      source: {
        content: labels,
        filePath: "diagnostic.txt",
        contentType: "text",
      },
      options: {
        config: SECRET_LINT_CONFIG,
        maskSecrets: true,
        noPhysicFilePath: true,
      },
    });
    return direct.messages.length === 0
      ? { name, workspace: workspace.relativeRoot }
      : undefined;
  } catch {
    return undefined;
  }
}
