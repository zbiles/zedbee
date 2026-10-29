import { posix } from "node:path";
import { parse, type ParseError } from "jsonc-parser";
import { readContainedFile } from "../../inspection/read-json.js";
import { captureSnapshotRegistry } from "../../inspection/snapshot-registry.js";
import type { WorkspaceInspection } from "../../inspection/types.js";

/** Metadata only: discover contained configuration inputs without building a
 * program or making unrelated invalid configurations block target selection.
 * Selected analyzers retain responsibility for validating their configuration.
 */
export async function compilerConfigurationPaths(
  snapshotRoot: string,
  workspace: WorkspaceInspection,
): Promise<ReadonlySet<string>> {
  const paths = new Set<string>(workspace.tsconfigPaths);
  if (paths.size === 0) return paths;
  const registry = await captureSnapshotRegistry(snapshotRoot);
  const pending = [...paths];
  while (pending.length > 0) {
    const path = pending.pop()!;
    let data: unknown;
    try {
      const errors: ParseError[] = [];
      data = parse(await readContainedFile(registry, path), errors, {
        allowTrailingComma: true,
      });
      if (errors.length > 0) continue;
    } catch {
      continue;
    }
    if (typeof data !== "object" || data === null || Array.isArray(data))
      continue;
    const config = data as Record<string, unknown>;
    const extensions = Array.isArray(config.extends)
      ? config.extends
      : [config.extends];
    const references = Array.isArray(config.references)
      ? config.references.map((reference: unknown) =>
          typeof reference === "object" &&
          reference !== null &&
          "path" in reference
            ? reference.path
            : undefined,
        )
      : [];
    const requests = [
      ...extensions.filter(
        (extension) =>
          typeof extension === "string" && extension.startsWith("."),
      ),
      ...references,
    ];
    for (const request of requests) {
      if (
        typeof request !== "string" ||
        request.length === 0 ||
        request.includes("\\") ||
        posix.isAbsolute(request) ||
        /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(request)
      )
        continue;
      const base = posix.normalize(posix.join(posix.dirname(path), request));
      if (base === ".." || base.startsWith("../")) continue;
      const resolved = [
        base,
        `${base}.json`,
        posix.join(base, "tsconfig.json"),
      ].find((candidate) => registry.resolve(candidate)?.targetKind === "file");
      if (resolved !== undefined && !paths.has(resolved)) {
        paths.add(resolved);
        pending.push(resolved);
      }
    }
  }
  return paths;
}
