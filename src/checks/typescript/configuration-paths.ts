import { posix, relative, sep } from "node:path";
import { parse, type ParseError } from "jsonc-parser";
import { readContainedFile } from "../../inspection/read-json.js";
import {
  captureSnapshotRegistry,
  IGNORED_DIRECTORY_NAMES,
  type SnapshotRegistry,
} from "../../inspection/snapshot-registry.js";
import type {
  RepositoryInspection,
  WorkspaceInspection,
} from "../../inspection/types.js";

/** One immutable inspection owns the acquisition cache. Only requested config
 * paths and their ancestors are inventoried, including canonical symlink targets.
 */
export type CompilerConfigurationInputs = Readonly<{
  paths: ReadonlySet<string>;
  complete: boolean;
}>;

function createResolver(
  snapshotRoot: string,
  retainMissingCandidates: boolean,
) {
  const files = new Map<string, Promise<SnapshotRegistry | undefined>>();
  const configurations = new Map<string, Promise<unknown>>();
  const workspaces = new WeakMap<
    WorkspaceInspection,
    Promise<CompilerConfigurationInputs>
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
  ): Promise<CompilerConfigurationInputs> => {
    let complete = true;
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
      if (typeof data !== "object" || data === null || Array.isArray(data)) {
        complete = false;
        continue;
      }
      const config = data as Record<string, unknown>;
      const extensions =
        config.extends === undefined
          ? []
          : Array.isArray(config.extends)
            ? config.extends
            : [config.extends];
      if (
        extensions.some((extension) => typeof extension !== "string") ||
        (config.references !== undefined && !Array.isArray(config.references))
      )
        complete = false;
      const references = Array.isArray(config.references)
        ? config.references.map((reference: unknown) =>
            typeof reference === "object" &&
            reference !== null &&
            "path" in reference
              ? reference.path
              : undefined,
          )
        : [];
      // Package-based extends are resolved by the compiler/dependency boundary.
      // Metadata discovery cannot prove their input closure complete.
      if (
        extensions.some(
          (extension) =>
            typeof extension !== "string" || !extension.startsWith("."),
        )
      )
        complete = false;
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
        ) {
          complete = false;
          continue;
        }
        const base = posix.normalize(posix.join(posix.dirname(path), request));
        if (base === ".." || base.startsWith("../")) {
          complete = false;
          continue;
        }
        const candidates = [
          base,
          `${base}.json`,
          posix.join(base, "tsconfig.json"),
        ];
        let found = false;
        for (const candidate of candidates) {
          if ((await fileRegistry(candidate)) === undefined) continue;
          found = true;
          paths.add(candidate);
          if (!parsed.has(candidate)) pending.push(candidate);
          break;
        }
        if (!found) {
          complete = false;
          if (retainMissingCandidates)
            for (const candidate of candidates) paths.add(candidate);
        }
      }
    }
    return Object.freeze({ paths, complete });
  };
  return (
    workspace: WorkspaceInspection,
  ): Promise<CompilerConfigurationInputs> => {
    let pending = workspaces.get(workspace);
    if (pending === undefined) {
      pending = discover(workspace);
      workspaces.set(workspace, pending);
    }
    return pending;
  };
}

export function createCompilerConfigurationInputResolver(snapshotRoot: string) {
  return createResolver(snapshotRoot, true);
}

// Cache by immutable selected inspection, never by reusable filesystem path.
const resolvers = new WeakMap<
  RepositoryInspection,
  ReturnType<typeof createCompilerConfigurationInputResolver>
>();
export function compilerConfigurationInputsForInspection(
  inspection: RepositoryInspection,
  workspace: WorkspaceInspection,
): Promise<CompilerConfigurationInputs> {
  let resolver = resolvers.get(inspection);
  if (resolver === undefined) {
    resolver = createCompilerConfigurationInputResolver(
      inspection.snapshotRoot,
    );
    resolvers.set(inspection, resolver);
  }
  return resolver(workspace);
}

/** Preserve the graph consumers' existing best-effort path-only contract. */
export function createCompilerConfigurationResolver(snapshotRoot: string) {
  const resolve = createResolver(snapshotRoot, false);
  return async (workspace: WorkspaceInspection): Promise<ReadonlySet<string>> =>
    (await resolve(workspace)).paths;
}

/** Metadata only; do not build programs or validate unrelated configurations. */
export function compilerConfigurationPaths(
  snapshotRoot: string,
  workspace: WorkspaceInspection,
): Promise<ReadonlySet<string>> {
  return createCompilerConfigurationResolver(snapshotRoot)(workspace);
}
