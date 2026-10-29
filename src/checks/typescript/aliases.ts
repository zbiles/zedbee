import ts from "typescript";
import { dirname, isAbsolute, posix, relative, resolve, sep } from "node:path";
import { readContainedFile } from "../../inspection/read-json.js";
import {
  captureSnapshotRegistry,
  IGNORED_DIRECTORY_NAMES,
} from "../../inspection/snapshot-registry.js";
import type {
  RepositoryInspection,
  WorkspaceInspection,
} from "../../inspection/types.js";
import { loadSnapshotProgramInput } from "./config.js";

export interface ImportComment {
  readonly type: "Block" | "Line";
  readonly start: number;
  readonly end: number;
  readonly value: string;
}

export type CommentImports = (
  comments: readonly ImportComment[],
  firstStatementStart: number,
  addImport: (specifier: string) => void,
) => void;

function staticModuleSpecifier(
  node: ts.Node,
  hasNodeModuleImport: boolean,
): string | undefined {
  if (
    (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
    node.moduleSpecifier !== undefined &&
    ts.isStringLiteralLike(node.moduleSpecifier)
  ) {
    return node.moduleSpecifier.text;
  }
  if (
    ts.isImportEqualsDeclaration(node) &&
    ts.isExternalModuleReference(node.moduleReference) &&
    node.moduleReference.expression !== undefined &&
    ts.isStringLiteralLike(node.moduleReference.expression)
  ) {
    return node.moduleReference.expression.text;
  }
  if (
    ts.isImportTypeNode(node) &&
    ts.isLiteralTypeNode(node.argument) &&
    ts.isStringLiteralLike(node.argument.literal)
  ) {
    return node.argument.literal.text;
  }
  if (
    ts.isCallExpression(node) &&
    node.arguments.length >= 1 &&
    ts.isStringLiteralLike(node.arguments[0]!) &&
    (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(node.expression) &&
        node.expression.text === "require" &&
        node.arguments.length === 1) ||
      (ts.isPropertyAccessExpression(node.expression) &&
        ((ts.isIdentifier(node.expression.expression) &&
          node.expression.expression.text === "require") ||
          (ts.isMetaProperty(node.expression.expression) &&
            node.expression.expression.keywordToken ===
              ts.SyntaxKind.ImportKeyword)) &&
        node.expression.name.text === "resolve"))
  ) {
    return node.arguments[0]!.text;
  }
  if (
    hasNodeModuleImport &&
    ts.isCallExpression(node) &&
    node.arguments[0] &&
    ts.isStringLiteralLike(node.arguments[0]) &&
    ((ts.isIdentifier(node.expression) &&
      node.expression.text === "register") ||
      (ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === "module" &&
        node.expression.name.text === "register"))
  ) {
    const base = node.arguments[1];
    if (
      !node.arguments[0].text.startsWith(".") ||
      (base &&
        ts.isPropertyAccessExpression(base) &&
        ts.isMetaProperty(base.expression) &&
        base.name.text === "url")
    )
      return node.arguments[0].text;
  }
  return undefined;
}

/** Static spellings shared by prevalidation and managed resolver configuration. */
export function sourceModuleSpecifiers(
  sourcePath: string,
  source: string,
  collectCommentImports?: CommentImports,
): readonly string[] {
  const file = ts.createSourceFile(
    sourcePath,
    source,
    ts.ScriptTarget.Latest,
    false,
    sourcePath.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const hasNodeModuleImport = file.statements.some(
    (statement) =>
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteralLike(statement.moduleSpecifier) &&
      ["node:module", "module"].includes(statement.moduleSpecifier.text),
  );
  const specifiers = new Set<string>();
  const comments = new Map<number, ImportComment>();
  const visit = (node: ts.Node): void => {
    if (collectCommentImports !== undefined) {
      for (const comment of [
        ...(ts.getLeadingCommentRanges(source, node.pos) ?? []),
        ...(ts.getTrailingCommentRanges(source, node.end) ?? []),
      ]) {
        const block = comment.kind === ts.SyntaxKind.MultiLineCommentTrivia;
        comments.set(comment.pos, {
          type: block ? "Block" : "Line",
          start: comment.pos,
          end: comment.end,
          value: source.slice(comment.pos + 2, comment.end - (block ? 2 : 0)),
        });
      }
    }
    const specifier = staticModuleSpecifier(node, hasNodeModuleImport);
    if (specifier !== undefined) specifiers.add(specifier);
    ts.forEachChild(node, visit);
  };
  visit(file);
  collectCommentImports?.(
    [...comments.values()],
    file.statements[0]?.getStart(file) ?? source.length,
    (specifier) => specifiers.add(specifier),
  );
  return [...specifiers];
}

/** Engines strip asset queries/fragments before local resolution. */
export function normalizedAliasSpecifier(specifier: string): string {
  const start = specifier.replace(/^[!-]+/u, "");
  const delimiter = start.search(/[?!]|(?<!^)#/u);
  return delimiter < 0 ? start : start.slice(0, delimiter);
}

export interface SnapshotAliases {
  readonly patterns: readonly string[];
  readonly configPath?: string;
  /** Returns a captured repository-relative file, never a host resolution. */
  resolve(sourcePath: string, specifier: string): string | undefined;
}

/** Select only one TS paths key: exact first, then longest wildcard prefix. */
function selectedMapping(
  paths: ts.MapLike<string[]>,
  specifier: string,
): { targets: readonly string[]; capture?: string } | undefined {
  if (Object.hasOwn(paths, specifier)) return { targets: paths[specifier]! };
  let selected: { targets: readonly string[]; capture: string } | undefined;
  let longestPrefix = -1;
  for (const [pattern, targets] of Object.entries(paths)) {
    const star = pattern.indexOf("*");
    if (star < 0 || star < longestPrefix) continue;
    const prefix = pattern.slice(0, star),
      suffix = pattern.slice(star + 1);
    if (
      specifier.length < prefix.length + suffix.length ||
      !specifier.startsWith(prefix) ||
      !specifier.endsWith(suffix)
    )
      continue;
    // TS keeps declaration order for equal-length prefixes.
    if (star === longestPrefix) continue;
    longestPrefix = star;
    selected = {
      targets,
      capture: specifier.slice(
        prefix.length,
        suffix.length === 0 ? undefined : -suffix.length,
      ),
    };
  }
  return selected;
}

/** Resolve using captured TS options and inventory; no engine reads host paths. */
export async function loadSnapshotAliases(
  snapshotRoot: string,
  workspace: WorkspaceInspection,
): Promise<SnapshotAliases> {
  if (workspace.tsconfigPaths.length === 0)
    return { patterns: [], resolve: () => undefined };
  const input = await loadSnapshotProgramInput(
    snapshotRoot,
    snapshotRoot,
    workspace,
  );
  const registry = await captureSnapshotRegistry(snapshotRoot);
  const paths = input.options.paths ?? {};
  const configFilePath = input.options.configFilePath;
  const pathsBasePath = input.options.pathsBasePath;
  const base =
    input.options.baseUrl ??
    (typeof pathsBasePath === "string"
      ? pathsBasePath
      : typeof configFilePath === "string"
        ? dirname(configFilePath)
        : snapshotRoot);
  const repositoryPath = (path: string): string => {
    const candidate = relative(snapshotRoot, resolve(path));
    if (
      isAbsolute(candidate) ||
      candidate === ".." ||
      candidate.startsWith(`..${sep}`)
    )
      throw new TypeError("TypeScript alias escaped the snapshot");
    return candidate.split(sep).join("/");
  };
  const entryFor = (path: string) => {
    try {
      return registry.resolve(repositoryPath(path));
    } catch {
      return undefined;
    }
  };
  const host: ts.ModuleResolutionHost = {
    fileExists: (path) => entryFor(path)?.targetKind === "file",
    directoryExists: (path) => entryFor(path)?.targetKind === "directory",
    readFile: (path) => {
      const entry = entryFor(path);
      return entry?.targetKind === "file"
        ? input.files[repositoryPath(entry.canonicalPath)]
        : undefined;
    },
    realpath: (path) => entryFor(path)?.canonicalPath ?? path,
    getCurrentDirectory: () => snapshotRoot,
    useCaseSensitiveFileNames: true,
  };
  const cache = ts.createModuleResolutionCache(
    snapshotRoot,
    (path) => path,
    input.options,
  );
  return {
    patterns: Object.keys(paths),
    ...(typeof configFilePath === "string"
      ? { configPath: repositoryPath(configFilePath) }
      : {}),
    resolve(sourcePath, rawSpecifier) {
      const specifier = normalizedAliasSpecifier(rawSpecifier);
      // `paths` applies only to bare module names. In particular, never feed a
      // captured absolute redirection back into a catch-all mapping.
      if (
        ts.isExternalModuleNameRelative(specifier) ||
        /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(specifier)
      )
        return undefined;
      const mapping = selectedMapping(paths, specifier);
      if (mapping === undefined) return undefined;
      const candidates = mapping.targets.map((target) => {
        const expanded =
          mapping.capture === undefined
            ? target
            : target.replaceAll("*", () => mapping.capture!);
        if (expanded.includes("\\") || /%(?:2e|2f|5c)/iu.test(expanded))
          throw new TypeError("Unsafe TypeScript alias target");
        const path = repositoryPath(resolve(base, expanded));
        if (
          path
            .split("/")
            .some((part) =>
              (IGNORED_DIRECTORY_NAMES as readonly string[]).includes(part),
            )
        )
          throw new TypeError("TypeScript alias targets an excluded path");
        return path;
      });
      const resolution = ts.resolveModuleName(
        specifier,
        resolve(snapshotRoot, sourcePath),
        input.options,
        host,
        cache,
      ).resolvedModule;
      if (resolution !== undefined) {
        const entry = entryFor(resolution.resolvedFileName);
        if (entry?.targetKind === "file")
          return repositoryPath(entry.canonicalPath);
      }
      // Stylesheets and other explicit asset imports have no TS module result.
      // Follow the selected mapping's ordered targets through the same inventory.
      return candidates.find(
        (path) =>
          /\.[^/]+$/u.test(path) &&
          registry.resolve(path)?.targetKind === "file",
      );
    },
  };
}

export interface PreparedSnapshotAliases {
  readonly workspaces: ReadonlyMap<string, SnapshotAliases>;
  readonly paths: ReadonlyMap<
    string,
    Readonly<Record<string, readonly string[]>>
  >;
  readonly sourceFiles: readonly string[];
}

/** Prepare the selected workspace and only statically reachable sibling scopes. */
export async function prepareSnapshotAliases(
  snapshotRoot: string,
  inspection: RepositoryInspection,
  selected: WorkspaceInspection,
  collectCommentImports?: CommentImports,
): Promise<PreparedSnapshotAliases> {
  const registry = await captureSnapshotRegistry(snapshotRoot);
  const workspaces = new Map<string, SnapshotAliases>();
  const paths = new Map<string, Readonly<Record<string, readonly string[]>>>();
  const sourceFiles = new Set<string>();
  const pending = [selected];
  const queued = new Set([selected.relativeRoot]);
  const scopes = [...inspection.workspaces].sort(
    (a, b) =>
      Number(a.relativeRoot === ".") - Number(b.relativeRoot === ".") ||
      b.relativeRoot.length - a.relativeRoot.length,
  );
  const scopeFor = (path: string) =>
    scopes.find(
      (scope) =>
        scope.relativeRoot === "." || path.startsWith(`${scope.relativeRoot}/`),
    );
  const enqueue = (scope: WorkspaceInspection | undefined) => {
    if (scope === undefined || queued.has(scope.relativeRoot)) return;
    queued.add(scope.relativeRoot);
    pending.push(scope);
  };
  for (const workspace of pending) {
    const aliases = await loadSnapshotAliases(snapshotRoot, workspace);
    workspaces.set(workspace.relativeRoot, aliases);
    const mappings: Record<string, readonly string[]> = Object.create(null);
    for (const sourcePath of workspace.sourceFiles) {
      sourceFiles.add(sourcePath);
      const source = await readContainedFile(registry, sourcePath);
      for (const specifier of sourceModuleSpecifiers(
        sourcePath,
        source,
        collectCommentImports,
      )) {
        const target = aliases.resolve(sourcePath, specifier);
        if (target !== undefined) {
          mappings[normalizedAliasSpecifier(specifier)] = [target];
          enqueue(scopeFor(target));
        } else if (specifier.startsWith(".")) {
          const candidate = posix.normalize(
            posix.join(posix.dirname(sourcePath), specifier),
          );
          const scope = scopeFor(candidate);
          const withoutExtension = candidate.replace(/\.[cm]?[jt]sx?$/iu, "");
          if (
            scope?.sourceFiles.some(
              (path) =>
                path === candidate ||
                path.replace(/\.[cm]?[jt]sx?$/iu, "") === withoutExtension ||
                path.startsWith(`${candidate}/`),
            )
          )
            enqueue(scope);
        } else {
          enqueue(
            scopes.find(
              (scope) =>
                scope.name !== undefined &&
                (specifier === scope.name ||
                  specifier.startsWith(`${scope.name}/`)),
            ),
          );
        }
      }
    }
    paths.set(workspace.relativeRoot, mappings);
  }
  return { workspaces, paths, sourceFiles: [...sourceFiles] };
}
