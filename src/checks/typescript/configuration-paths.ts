import { posix, relative, sep } from "node:path";
import { parse, type ParseError } from "jsonc-parser";
import { readContainedFile } from "../../inspection/read-json.js";
import {
  captureSnapshotRegistry,
  IGNORED_DIRECTORY_NAMES,
  type SnapshotRegistry,
} from "../../inspection/snapshot-registry.js";
import type { WorkspaceInspection } from "../../inspection/types.js";

/** One immutable inspection owns the acquisition cache. Only requested config
 * paths and their ancestors are inventoried, including canonical symlink targets.
 */
export function createCompilerConfigurationResolver(snapshotRoot: string) {
  const files = new Map<string, Promise<SnapshotRegistry | undefined>>();
  const configurations = new Map<string, Promise<unknown>>();
  const workspaces = new WeakMap<
    WorkspaceInspection,
    Promise<ReadonlySet<string>>
  >();
  const excluded = new Set<string>(IGNORED_DIRECTORY_NAMES);

  const fileRegistry = (
    path: string,
  ): Promise<SnapshotRegistry | undefined> => {
    let pending = files.get(path);
    if (pending === undefined) {
      pending = (async () => {
        try {
          const registry = await captureSnapshotRegistry(snapshotRoot, [path]);
          if (
            registry
              .entries()
              .some((entry) =>
                entry.repositoryPath
                  .split("/")
                  .some((part) => excluded.has(part)),
              )
          )
            return undefined;
          return registry.resolve(path)?.targetKind === "file"
            ? registry
            : undefined;
        } catch {
          // Missing, invalid and uncontained inputs cannot contribute metadata.
          // Selected analyzers remain responsible for configuration validation.
          return undefined;
        }
      })();
      files.set(path, pending);
    }
    return pending;
  };

  const configuration = (path: string): Promise<unknown> => {
    let pending = configurations.get(path);
    if (pending === undefined) {
      pending = (async () => {
        try {
          const registry = await fileRegistry(path);
          if (registry === undefined) return undefined;
          const errors: ParseError[] = [];
          const data: unknown = parse(
            await readContainedFile(registry, path),
            errors,
            {
              allowTrailingComma: true,
            },
          );
          return errors.length === 0 ? data : undefined;
        } catch {
          return undefined;
        }
      })();
      configurations.set(path, pending);
    }
    return pending;
  };

  const discover = async (
    workspace: WorkspaceInspection,
  ): Promise<ReadonlySet<string>> => {
    const paths = new Set<string>(workspace.tsconfigPaths);
    // Only lexical requests are parsed: relative extends are based on the
    // requested alias, not on the canonical target's directory.
    const parsed = new Set<string>();
    const pending = [...paths];
    while (pending.length > 0) {
      const path = pending.pop()!;
      if (parsed.has(path)) continue;
      parsed.add(path);
      const registry = await fileRegistry(path);
      for (const entry of registry?.entries() ?? []) {
        if (entry.kind === "symlink") paths.add(entry.repositoryPath);
        if (entry.targetKind === "file") {
          paths.add(entry.repositoryPath);
          paths.add(
            relative(snapshotRoot, entry.canonicalPath).split(sep).join("/"),
          );
        }
      }
      const data = await configuration(path);
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
        for (const candidate of [
          base,
          `${base}.json`,
          posix.join(base, "tsconfig.json"),
        ]) {
          if ((await fileRegistry(candidate)) === undefined) continue;
          paths.add(candidate);
          if (!parsed.has(candidate)) pending.push(candidate);
          break;
        }
      }
    }
    return paths;
  };
  return (workspace: WorkspaceInspection): Promise<ReadonlySet<string>> => {
    let pending = workspaces.get(workspace);
    if (pending === undefined) {
      pending = discover(workspace);
      workspaces.set(workspace, pending);
    }
    return pending;
  };
}

/** Metadata only; do not build programs or validate unrelated configurations. */
export function compilerConfigurationPaths(
  snapshotRoot: string,
  workspace: WorkspaceInspection,
): Promise<ReadonlySet<string>> {
  return createCompilerConfigurationResolver(snapshotRoot)(workspace);
}
