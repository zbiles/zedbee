import { configCandidates } from "./config-candidates.js";
import { posix, relative, sep } from "node:path";
import { parse, type ParseError } from "jsonc-parser";
import {
  readContainedFile,
  ContainedFileSizeError,
} from "../../inspection/read-json.js";
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
  limited?: true;
}>;

function createResolver(
  snapshotRoot: string,
  retainMissingCandidates: boolean,
  signal?: AbortSignal,
) {
  let exhausted = false;
  let parsedCount = 0;
  let retainedBytes = 0;
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
    signal?.throwIfAborted();
    let pending = files.get(path);
    if (pending === undefined) {
      if (retainMissingCandidates && files.size >= 192) {
        exhausted = true;
        return Promise.resolve(undefined);
      }
      pending = (async () => {
        try {
          const registry = await captureSnapshotRegistry(snapshotRoot, [path]);
          signal?.throwIfAborted();
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
        } catch (error) {
          if (
            retainMissingCandidates &&
            error instanceof ContainedFileSizeError
          )
            exhausted = true;
          signal?.throwIfAborted();
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
          const text = await readContainedFile(
            registry,
            path,
            retainMissingCandidates ? { maxBytes: 64 * 1024 } : {},
          );
          signal?.throwIfAborted();
          retainedBytes += text.length * 2;
          if (retainMissingCandidates && retainedBytes > 4 * 1024 * 1024) {
            exhausted = true;
            return undefined;
          }
          const data: unknown = parse(text, errors, {
            allowTrailingComma: true,
          });
          return errors.length === 0 ? data : undefined;
        } catch (error) {
          if (
            retainMissingCandidates &&
            error instanceof ContainedFileSizeError
          )
            exhausted = true;
          signal?.throwIfAborted();
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
    signal?.throwIfAborted();
    if (retainMissingCandidates && workspace.tsconfigPaths.length > 64)
      return Object.freeze({
        paths: new Set<string>(),
        complete: false,
        limited: true,
      });
    const paths = new Set<string>(workspace.tsconfigPaths);
    // Only lexical requests are parsed: relative extends are based on the
    // requested alias, not on the canonical target's directory.
    const parsed = new Set<string>();
    const pending = [...paths];
    while (pending.length > 0) {
      signal?.throwIfAborted();
      if (retainMissingCandidates && (parsedCount >= 64 || exhausted)) {
        exhausted = true;
        complete = false;
        break;
      }
      const path = pending.pop()!;
      if (parsed.has(path)) continue;
      parsed.add(path);
      parsedCount++;
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
        ...extensions
          .filter(
            (extension) =>
              typeof extension === "string" && extension.startsWith("."),
          )
          .map((path) => ({ path, kind: "extends" as const })),
        ...references.map((path) => ({ path, kind: "reference" as const })),
      ];
      for (const { path: request, kind } of requests) {
        signal?.throwIfAborted();
        if (exhausted) {
          complete = false;
          break;
        }
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
        const candidates = configCandidates(base, kind);
        let found = false;
        for (const candidate of candidates) {
          signal?.throwIfAborted();
          if ((await fileRegistry(candidate)) === undefined) {
            if (retainMissingCandidates) paths.add(candidate);
            continue;
          }
          found = true;
          paths.add(candidate);
          if (!parsed.has(candidate)) pending.push(candidate);
          break;
        }
        if (!found) complete = false;
      }
    }
    return Object.freeze({
      paths,
      complete: complete && !exhausted,
      ...(exhausted ? { limited: true as const } : {}),
    });
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

export function createCompilerConfigurationInputResolver(
  snapshotRoot: string,
  signal?: AbortSignal,
) {
  return createResolver(snapshotRoot, true, signal);
}

// Cache by immutable selected inspection, never by reusable filesystem path.
const resolvers = new WeakMap<
  RepositoryInspection,
  ReturnType<typeof createCompilerConfigurationInputResolver>
>();
const signalResolvers = new WeakMap<AbortSignal, typeof resolvers>();
export function compilerConfigurationInputsForInspection(
  inspection: RepositoryInspection,
  workspace: WorkspaceInspection,
  signal?: AbortSignal,
): Promise<CompilerConfigurationInputs> {
  signal?.throwIfAborted();
  const cache =
    signal === undefined
      ? resolvers
      : (signalResolvers.get(signal) ?? new WeakMap());
  if (signal !== undefined) signalResolvers.set(signal, cache);
  let resolver = cache.get(inspection);
  if (resolver === undefined) {
    resolver = createCompilerConfigurationInputResolver(
      inspection.snapshotRoot,
      signal,
    );
    cache.set(inspection, resolver);
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
