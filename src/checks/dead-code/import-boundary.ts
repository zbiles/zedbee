import { lstat } from "node:fs/promises";
import { isBuiltin } from "node:module";
import { dirname, join, posix } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readJsonData } from "../../inspection/read-json.js";
import type { SnapshotRegistry } from "../../inspection/snapshot-registry.js";

const WINDOWS_PATH = /^[A-Za-z]:[/\\]/u;
const URL = /^[A-Za-z][A-Za-z0-9+.-]*:/u;
const NODE_CONDITIONS = new Set(["require", "import", "node", "default"]);
const BROWSER_CONDITIONS = new Set(["require", "import", "browser", "default"]);
const MAX_TARGET_DEPTH = 32;

function unsafeImport(): never {
  throw new TypeError("Dead-code import escaped the snapshot");
}

function validateSpecifier(sourcePath: string, specifier: string): void {
  if (
    specifier.includes("\\") ||
    posix.isAbsolute(specifier) ||
    WINDOWS_PATH.test(specifier) ||
    (URL.test(specifier) &&
      !specifier.startsWith("node:") &&
      !specifier.startsWith("bun:"))
  )
    unsafeImport();
  if (!specifier.startsWith(".")) return;
  const resolved = posix.normalize(
    posix.join(posix.dirname(sourcePath), specifier),
  );
  if (resolved === ".." || resolved.startsWith("../")) unsafeImport();
}

async function assertMissing(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if (
      ["ENOENT", "ENOTDIR"].includes(
        (error as NodeJS.ErrnoException).code ?? "",
      )
    )
      return;
    throw error;
  }
  throw new TypeError("Dead-code dependency resolution escaped the snapshot");
}

async function validatePackage(
  snapshotRoot: string,
  sourcePath: string,
  specifier: string,
): Promise<void> {
  const parts = specifier.split("/");
  const name = specifier.startsWith("@")
    ? parts.slice(0, 2).join("/")
    : parts[0]!;
  let directory = dirname(join(snapshotRoot, sourcePath));
  while (true) {
    await assertMissing(join(directory, "node_modules", ...name.split("/")));
    const parent = dirname(directory);
    if (parent === directory) return;
    directory = parent;
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

interface Mapping {
  readonly key: string;
  readonly value: unknown;
  readonly capture?: string;
}

// Match the pinned resolver's exact-first / most-specific-pattern ordering.
// This only selects an imports mapping; Knip still performs actual resolution.
function selectMapping(
  imports: Record<string, unknown>,
  specifier: string,
): Mapping | undefined {
  if (!specifier.includes("*") && Object.hasOwn(imports, specifier)) {
    return { key: specifier, value: imports[specifier] };
  }
  let best: Mapping | undefined;
  let bestPrefix = -1;
  for (const key of Object.keys(imports)) {
    if (!key.startsWith("#")) continue;
    const star = key.indexOf("*");
    const prefix = star < 0 ? key : key.slice(0, star);
    const suffix = star < 0 ? "" : key.slice(star + 1);
    if (star < 0 && !key.endsWith("/")) continue;
    if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) continue;
    if (
      specifier.length < key.length ||
      (star < 0 && specifier.length === key.length)
    )
      continue;
    const prefixLength = star < 0 ? key.length : star + 1;
    if (
      prefixLength < bestPrefix ||
      (prefixLength === bestPrefix && best && key.length <= best.key.length)
    )
      continue;
    best = {
      key,
      value: imports[key],
      capture: specifier.slice(
        prefix.length,
        suffix.length ? -suffix.length : undefined,
      ),
    };
    bestPrefix = prefixLength;
  }
  return best;
}

// Oxc parses target query/fragment components before replacing wildcard captures.
function targetPath(value: string): string {
  const delimiter = value.search(/[?]|(?<!^)#/u);
  return delimiter < 0 ? value : value.slice(0, delimiter);
}

function validateTargetPath(target: string): void {
  if (target.length === 0 || target.includes("\0")) unsafeImport();
  validateSpecifier("package.json", target);
  const path = target.startsWith("./") ? target.slice(2) : target;
  // Do not let native decoding or path normalization hide a traversal/ignored install.
  if (
    /%(?:2e|2f|5c)/iu.test(path) ||
    path
      .split("/")
      .some(
        (part) =>
          part === "." ||
          part === ".." ||
          part.toLowerCase() === "node_modules",
      )
  )
    unsafeImport();
}

interface Selection {
  readonly path: string;
  readonly imports?: Record<string, unknown>;
}

export interface KnipComment {
  readonly type: "Block" | "Line";
  readonly start: number;
  readonly end: number;
  readonly value: string;
}

type CommentCollector = (
  comments: readonly KnipComment[],
  firstStatementStart: number,
  addImport: (specifier: string) => void,
) => void;

export async function createKnipImportValidator(
  registry: SnapshotRegistry,
): Promise<{
  validateImport: (sourcePath: string, specifier: string) => Promise<void>;
  collectCommentImports: CommentCollector;
}> {
  // Reuse the pinned engine's spelling rules (loader prefixes, queries, fragments),
  // so validation sees the same source specifier as Knip. Never load project code.
  const knipModule = fileURLToPath(import.meta.resolve("knip"));
  const module = (await import(
    pathToFileURL(join(dirname(knipModule), "util", "modules.js")).href
  )) as {
    sanitizeSpecifier?: unknown;
  };
  if (typeof module.sanitizeSpecifier !== "function")
    throw new TypeError("Invalid pinned Knip module helpers");
  const sanitizeSpecifier = module.sanitizeSpecifier as (
    value: string,
  ) => string;
  const commentsModule = (await import(
    pathToFileURL(join(dirname(knipModule), "typescript", "comments.js")).href
  )) as { extractImportsFromComments?: unknown };
  if (typeof commentsModule.extractImportsFromComments !== "function")
    throw new TypeError("Invalid pinned Knip comment helpers");
  const scopes = new Map<string, Promise<Selection | undefined>>();
  const scopeFor = (sourcePath: string): Promise<Selection | undefined> => {
    const start = posix.dirname(sourcePath);
    let found = scopes.get(start);
    if (!found) {
      found = (async () => {
        let directory = start;
        while (true) {
          const path = posix.join(directory, "package.json");
          if (registry.resolve(path) !== undefined) {
            const manifest = await readJsonData(registry, path);
            if (!record(manifest))
              throw new TypeError("Invalid package manifest");
            return {
              path,
              ...(record(manifest.imports)
                ? { imports: manifest.imports }
                : {}),
            };
          }
          if (directory === ".") return undefined;
          directory = posix.dirname(directory);
        }
      })();
      scopes.set(start, found);
    }
    return found;
  };

  const validateLocalTarget = async (
    path: string,
    seen = new Set<string>(),
  ): Promise<void> => {
    if (
      path === ".." ||
      path.startsWith("../") ||
      path.split("/").some((part) => part.toLowerCase() === "node_modules")
    )
      unsafeImport();
    if (seen.has(path)) return;
    if (seen.size > MAX_TARGET_DEPTH)
      throw new TypeError("Package entrypoints are too deeply nested");
    seen.add(path);
    const entry = registry.resolve(path);
    if (!entry) {
      // A missing target is an ordinary unresolved import, but an existing path
      // excluded from the inventory must not become a back door into analysis.
      await assertMissing(join(registry.snapshotRoot, path));
      return;
    }
    if (entry.targetKind !== "directory") return;
    const manifestPath = posix.join(path, "package.json");
    if (!registry.resolve(manifestPath)) return;
    const manifest = await readJsonData(registry, manifestPath);
    // Pinned Oxc uses main for local directory resolution. Follow it only through
    // inventoried paths; ../ is valid here when it remains inside the snapshot.
    if (
      record(manifest) &&
      typeof manifest.main === "string" &&
      manifest.main
    ) {
      const main = targetPath(manifest.main);
      validateSpecifier(
        manifestPath,
        main.startsWith(".") ? main : `./${main}`,
      );
      if (
        posix.isAbsolute(main) ||
        WINDOWS_PATH.test(main) ||
        URL.test(main) ||
        /%(?:2e|2f|5c)/iu.test(main)
      )
        unsafeImport();
      await validateLocalTarget(posix.normalize(posix.join(path, main)), seen);
    }
  };

  const validateImport = async (
    sourcePath: string,
    rawSpecifier: string,
  ): Promise<void> => {
    validateSpecifier(sourcePath, rawSpecifier);
    const specifier = sanitizeSpecifier(rawSpecifier);
    validateSpecifier(sourcePath, specifier);
    if (!specifier.startsWith("#")) {
      if (!specifier.startsWith(".") && !isBuiltin(specifier)) {
        await validatePackage(registry.snapshotRoot, sourcePath, specifier);
      }
      return;
    }
    const scope = await scopeFor(sourcePath);
    if (!scope?.imports) return;
    const mapping = selectMapping(scope.imports, specifier);
    if (!mapping) return;

    const visit = async (
      value: unknown,
      conditions: ReadonlySet<string>,
      depth: number,
    ): Promise<string | undefined> => {
      if (depth > MAX_TARGET_DEPTH)
        throw new TypeError("Package import aliases are too deeply nested");
      if (typeof value === "string") {
        let target = targetPath(value);
        if (mapping.capture !== undefined) {
          target =
            mapping.key.endsWith("/") &&
            target.endsWith("/") &&
            !target.includes("*")
              ? target + mapping.capture
              : target.replaceAll("*", () => mapping.capture!);
        }
        validateTargetPath(target);
        if (target.startsWith("./")) {
          const localPath = posix.join(posix.dirname(scope.path), target);
          await validateLocalTarget(localPath);
          return localPath;
        }
        // An alias target is resolved as a package, even when named "fs" or "#x".
        // It is NOT a new source import to which builtin/# exclusions apply.
        await validatePackage(registry.snapshotRoot, scope.path, target);
        return undefined; // Every install is absent: Oxc can try an array fallback.
      }
      if (Array.isArray(value)) {
        for (const item of value) {
          const target = await visit(item, conditions, depth + 1);
          if (target !== undefined) return target;
        }
      } else if (record(value)) {
        for (const [condition, item] of Object.entries(value)) {
          if (!conditions.has(condition)) continue;
          const target = await visit(item, conditions, depth + 1);
          if (target !== undefined) return target;
        }
      }
      return undefined;
    };
    // Knip uses both condition sets. An existing local file does not prove its
    // primary resolver succeeds (for example, tsconfig resolution can fail first).
    // Validate the selected mapping in both, not every condition or unused alias.
    await visit(mapping.value, NODE_CONDITIONS, 0);
    await visit(mapping.value, BROWSER_CONDITIONS, 0);
  };
  return {
    validateImport,
    collectCommentImports:
      commentsModule.extractImportsFromComments as CommentCollector,
  };
}
