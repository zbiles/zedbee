import { posix, relative, sep } from "node:path";
import type { Expression, Node } from "typescript";
import { compareCodeUnits } from "../../core/compare.js";
import {
  ContainedFileSizeError,
  readContainedFile,
} from "../../inspection/read-json.js";
import {
  captureSnapshotRegistry,
  type SnapshotRegistry,
} from "../../inspection/snapshot-registry.js";
import type {
  RepositoryInspection,
  WorkspaceInspection,
} from "../../inspection/types.js";
import { owningWorkspace } from "../../inspection/workspace-owner.js";
import { CheckIncompleteError } from "../incomplete-error.js";

const SOURCE = /\.(?:js|jsx|mjs|cjs|ts|tsx|mts|cts)$/iu;
const CONFIGS = ["js", "mjs", "ts", "cjs", "mts", "cts"].map(
  (ext) => `vite.config.${ext}`,
);
const MAX_HTML_BYTES = 256 * 1024;
const MAX_NODES = 16384;
const prefix = (workspace: WorkspaceInspection) =>
  workspace.relativeRoot === "." ? "" : `${workspace.relativeRoot}/`;
export const declaresVite = (workspace: WorkspaceInspection): boolean =>
  workspace.dependencyDeclarations.some(({ name }) => name === "vite");
export function viteInputPaths(
  workspace: WorkspaceInspection,
  explicit: readonly string[] = [],
): readonly string[] {
  return [
    ...(declaresVite(workspace)
      ? ["index.html", ...CONFIGS].map((path) => `${prefix(workspace)}${path}`)
      : []),
    ...explicit,
  ];
}
const inputClosures = new WeakMap<
  RepositoryInspection,
  Map<string, Promise<readonly string[]>>
>();
/** Targeted metadata only, retaining every contained symlink hop and absence. */
export function viteInputPathsForInspection(
  inspection: RepositoryInspection,
  workspace: WorkspaceInspection,
  explicit: readonly string[] = [],
): Promise<readonly string[]> {
  let cache = inputClosures.get(inspection);
  if (cache === undefined) {
    cache = new Map();
    inputClosures.set(inspection, cache);
  }
  const key = JSON.stringify([workspace.relativeRoot, explicit]);
  let pending = cache.get(key);
  if (pending === undefined) {
    pending = (async () => {
      const paths = new Set(viteInputPaths(workspace, explicit));
      if (paths.size === 0) return [];
      try {
        const registry = await captureSnapshotRegistry(
          inspection.snapshotRoot,
          [...paths],
        );
        for (const entry of registry.entries()) {
          if (entry.targetKind === "file" || entry.kind === "symlink")
            paths.add(entry.repositoryPath);
          if (entry.targetKind === "file")
            paths.add(canonicalRepositoryPath(registry, entry.canonicalPath));
        }
      } catch {
        /* Selected analyzer owns unsafe or unavailable input diagnostics. */
      }
      return [...paths].sort(compareCodeUnits);
    })();
    cache.set(key, pending);
  }
  return pending;
}
function canonicalRepositoryPath(
  registry: SnapshotRegistry,
  canonicalPath: string,
): string {
  return relative(registry.snapshotRoot, canonicalPath).split(sep).join("/");
}
function unsupported(path: string, reason: string): never {
  throw new CheckIncompleteError({
    code: "DEAD_CODE_ENTRYPOINT_UNSUPPORTED",
    path,
    message: `Dead-code entry discovery could not complete: ${reason}.`,
    remediation:
      "Set checks.deadCode.entryPoints to exact repository-relative source paths for custom Vite roots, library/multi-page builds, or inline/plugin-generated modules. Repair missing or unsafe entry references before retrying.",
  });
}
/** Unique deepest lexical owner; canonical ownership is checked separately. */
export function entryOwner(
  inspection: RepositoryInspection,
  path: string,
): WorkspaceInspection | undefined {
  return owningWorkspace(inspection.workspaces, path);
}
interface HtmlNode {
  kind?: string;
  name?: string;
  value?: string;
  attrs?: readonly (HtmlNode & {
    valueTokens?: readonly { parts: readonly string[] }[];
  })[];
  children?: readonly HtmlNode[];
}
function attribute(node: HtmlNode, name: string): string | undefined {
  const attr = node.attrs?.find((a) => a.name?.toLowerCase() === name);
  return (
    attr?.valueTokens?.map((token) => token.parts[0] ?? "").join("") ??
    attr?.value
  );
}
async function htmlSources(
  text: string,
  path: string,
  explicitSources: boolean,
): Promise<readonly string[]> {
  if (Buffer.byteLength(text) > MAX_HTML_BYTES)
    unsupported(path, "HTML exceeds the 256 KiB parser budget");
  let root: HtmlNode;
  try {
    const { parsers } = await import("prettier/plugins/html");
    root = (await parsers.html.parse(
      text,
      {} as Parameters<typeof parsers.html.parse>[1],
    )) as HtmlNode;
  } catch {
    return unsupported(path, "HTML is malformed or exceeds parser limits");
  }
  const pending: HtmlNode[] = [root];
  const sources: string[] = [];
  let count = 0;
  while (pending.length) {
    const node = pending.pop()!;
    if (++count > MAX_NODES) unsupported(path, "HTML exceeds the node budget");
    const name = node.name?.toLowerCase();
    if (name === "template" || name === "noscript") continue;
    if (name === "base" && attribute(node, "href") !== undefined) {
      if (explicitSources) return [];
      unsupported(path, "HTML base URLs require explicit source entries");
    }
    if (name === "script" && attribute(node, "type") === "module") {
      if (attribute(node, "vite-ignore") !== undefined) {
        if (explicitSources) continue;
        unsupported(
          path,
          "vite-ignore modules require explicit source entries",
        );
      }
      const src = attribute(node, "src")?.trim();
      if (!src) {
        if (explicitSources) continue;
        unsupported(
          path,
          "inline or empty module scripts require explicit source entries",
        );
      }
      sources.push(src);
    }
    pending.push(...(node.children ?? []));
  }
  return sources;
}
function sourcePath(
  html: string,
  src: string,
  workspace: WorkspaceInspection,
  explicitSources: boolean,
): string | undefined {
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/iu.test(src)) return undefined;
  const [urlPath, query] = src.split("#", 1)[0]!.split("?", 2);
  if (
    query !== undefined &&
    [...new URLSearchParams(query).keys()].some((key) =>
      ["raw", "url", "worker", "sharedworker", "inline"].includes(key),
    )
  ) {
    if (explicitSources) return undefined;
    unsupported(html, "module URL changes JavaScript loading semantics");
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath!);
  } catch {
    return unsupported(html, "module URL has invalid percent encoding");
  }
  if (
    !decoded ||
    /[\\\p{Cc}]/u.test(decoded) ||
    decoded.startsWith("//") ||
    (decoded.split("/").includes("..") &&
      (decoded.startsWith("/") || /%2e/iu.test(urlPath!)))
  )
    unsupported(html, "module URL escapes its workspace");
  return posix.normalize(
    decoded.startsWith("/")
      ? `${prefix(workspace)}${decoded.slice(1)}`
      : posix.join(posix.dirname(html), decoded),
  );
}
export async function resolveViteEntrypoints(
  inspection: RepositoryInspection,
  workspace: WorkspaceInspection,
  registry: SnapshotRegistry,
  explicit: readonly string[] = [],
  capture?: (path: string) => void,
  allowMissingExplicit = false,
): Promise<{
  entry: readonly string[];
  ignoreDependencies: readonly string[];
}> {
  const owned = (path: string): boolean => {
    const resolved = registry.resolve(path);
    if (
      resolved?.targetKind !== "file" ||
      entryOwner(inspection, path)?.relativeRoot !== workspace.relativeRoot
    )
      return false;
    const canonical = canonicalRepositoryPath(registry, resolved.canonicalPath);
    return (
      entryOwner(inspection, canonical)?.relativeRoot === workspace.relativeRoot
    );
  };
  const entries = new Set<string>();
  const addSource = (path: string, origin: string) => {
    if (
      path === ".." ||
      path.startsWith("../") ||
      posix.isAbsolute(path) ||
      entryOwner(inspection, path)?.relativeRoot !== workspace.relativeRoot
    )
      unsupported(origin, "entry URL escapes its owning workspace");
    capture?.(path);
    if (!SOURCE.test(path) || /\.d\.[cm]?ts$/iu.test(path) || !owned(path))
      unsupported(
        origin,
        "entry source is missing, unsupported, or owned by another workspace",
      );
    // The lexical alias itself may not appear in sourceFiles; Knip can resolve a
    // contained alias, but never root an undiscovered canonical source.
    const canonical = canonicalRepositoryPath(
      registry,
      registry.resolve(path)!.canonicalPath,
    );
    if (
      !workspace.sourceFiles.includes(canonical) &&
      !workspace.sourceFiles.includes(path)
    )
      unsupported(origin, "entry source was excluded from project discovery");
    entries.add(path.slice(prefix(workspace).length));
    // Knip inventories lexical aliases and their canonical file separately.
    // Keep both identities rooted for a contained HTML entry.
    entries.add(canonical.slice(prefix(workspace).length));
  };
  const selected = explicit
    .filter(
      (path) =>
        entryOwner(inspection, path)?.relativeRoot === workspace.relativeRoot,
    )
    .filter((path) => {
      capture?.(path);
      return !(
        allowMissingExplicit &&
        registry.resolve(path) === undefined &&
        !registry.unavailableSymlinks?.has(path)
      );
    });
  const isVite = declaresVite(workspace);
  let customConfiguration = false;
  let selectedConfig = false;
  const htmlPaths = new Set(selected.filter((path) => /\.html$/iu.test(path)));
  if (isVite) {
    for (const config of CONFIGS) {
      const path = `${prefix(workspace)}${config}`;
      capture?.(path);
      if (registry.resolve(path)?.targetKind !== "file" || selectedConfig)
        continue;
      selectedConfig = true;
      addSource(path, path);
      const text = await readContainedFile(registry, path);
      const ts = (await import("typescript")).default;
      const ast = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
      let custom = false;
      const supported = (expression: Expression): boolean => {
        if (ts.isParenthesizedExpression(expression))
          return supported(expression.expression);
        if (ts.isObjectLiteralExpression(expression)) return true;
        if (
          ts.isCallExpression(expression) &&
          expression.expression.getText(ast) === "defineConfig" &&
          expression.arguments.length === 1
        ) {
          const value = expression.arguments[0]!;
          if (ts.isArrowFunction(value) && !ts.isBlock(value.body))
            return supported(value.body);
          return supported(value);
        }
        return false;
      };
      const exportedPath = (node: Expression): string | undefined => {
        if (ts.isIdentifier(node)) return node.text;
        if (ts.isPropertyAccessExpression(node)) {
          const owner = exportedPath(node.expression);
          return owner === undefined ? undefined : `${owner}.${node.name.text}`;
        }
        if (ts.isElementAccessExpression(node)) {
          const owner = exportedPath(node.expression);
          return owner === undefined
            ? undefined
            : `${owner}.${ts.isStringLiteral(node.argumentExpression) ? node.argumentExpression.text : "[computed]"}`;
        }
        return undefined;
      };
      const visit = (node: Node): void => {
        if (
          (ts.isPropertyAssignment(node) ||
            ts.isShorthandPropertyAssignment(node)) &&
          ["root", "rollupOptions", "rolldownOptions", "lib"].includes(
            ts.isComputedPropertyName(node.name) &&
              ts.isStringLiteral(node.name.expression)
              ? node.name.expression.text
              : node.name.getText(ast).replace(/['"]/gu, ""),
          )
        )
          custom = true;
        if (
          (ts.isShorthandPropertyAssignment(node) &&
            node.name.text === "build") ||
          (ts.isPropertyAssignment(node) &&
            node.name.getText(ast).replace(/['"]/gu, "") === "build" &&
            !ts.isObjectLiteralExpression(node.initializer))
        )
          custom = true;
        // Spreads/re-exports and opaque exports can hide custom roots or build
        // inputs. Refuse inference without evaluating the configuration.
        if (
          ts.isSpreadAssignment(node) ||
          (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined)
        )
          custom = true;
        if (ts.isExportAssignment(node)) {
          if (!supported(node.expression)) custom = true;
        }
        if (
          ts.isBinaryExpression(node) &&
          node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
          node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
        ) {
          const path = exportedPath(node.left);
          if (path === "module.exports" || path === "exports.default") {
            if (
              node.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
              !supported(node.right)
            )
              custom = true;
          } else if (
            path?.startsWith("module.exports.") ||
            path?.startsWith("exports.")
          ) {
            custom = true;
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(ast);
      customConfiguration ||= custom;
      if (custom && !selected.some((path) => !/\.html$/iu.test(path)))
        unsupported(
          path,
          "custom or opaque Vite configuration requires explicit source entries",
        );
    }
    const path = `${prefix(workspace)}index.html`;
    capture?.(path);
    if (!customConfiguration && registry.resolve(path)?.targetKind === "file")
      htmlPaths.add(path);
  }
  for (const path of selected) if (!htmlPaths.has(path)) addSource(path, path);
  let moduleEntries = 0;
  for (const html of htmlPaths) {
    capture?.(html);
    if (!owned(html))
      unsupported(html, "HTML entry is missing or owned by another workspace");
    let text: string;
    try {
      text = await readContainedFile(registry, html, {
        maxBytes: MAX_HTML_BYTES,
      });
    } catch (error) {
      if (error instanceof ContainedFileSizeError)
        unsupported(html, "HTML exceeds the 256 KiB parser budget");
      throw error;
    }
    for (const src of await htmlSources(
      text,
      html,
      selected.some((path) => SOURCE.test(path)),
    )) {
      const path = sourcePath(
        html,
        src,
        workspace,
        selected.some((path) => SOURCE.test(path)),
      );
      if (path !== undefined) {
        addSource(path, html);
        moduleEntries++;
      }
    }
  }
  return {
    entry: [...entries].sort(compareCodeUnits),
    ignoreDependencies: isVite && moduleEntries > 0 ? ["vite"] : [],
  };
}
