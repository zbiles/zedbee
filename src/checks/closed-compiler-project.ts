import ts from "typescript";
import { parse, type ParseError } from "jsonc-parser";
import { captureSnapshotRegistry } from "../inspection/snapshot-registry.js";
import { readContainedFile } from "../inspection/read-json.js";
import type {
  RepositoryInspection,
  WorkspaceInspection,
} from "../inspection/types.js";
const proofs = new WeakMap<
  RepositoryInspection,
  WeakMap<WorkspaceInspection, Promise<boolean>>
>();

/** A deliberately narrow proof. Anything beyond a self-contained module-only
 * project retains broad compiler coverage. This is not an import-graph guess. */
export function isClosedCompilerProject(
  inspection: RepositoryInspection,
  workspace: WorkspaceInspection,
): Promise<boolean> {
  let entries = proofs.get(inspection);
  if (entries === undefined) {
    entries = new WeakMap();
    proofs.set(inspection, entries);
  }
  let proof = entries.get(workspace);
  if (proof === undefined) {
    proof = proveClosedProject(inspection, workspace);
    entries.set(workspace, proof);
  }
  return proof;
}

async function proveClosedProject(
  inspection: RepositoryInspection,
  workspace: WorkspaceInspection,
): Promise<boolean> {
  const prefix =
    workspace.relativeRoot === "." ? "" : `${workspace.relativeRoot}/`;
  if (
    workspace.sourceFiles.length > 500 ||
    workspace.tsconfigPaths.length !== 1 ||
    workspace.tsconfigPaths[0] !== `${prefix}tsconfig.json`
  )
    return false;
  try {
    const registry = await captureSnapshotRegistry(inspection.snapshotRoot, [
      ...workspace.sourceFiles,
      ...workspace.tsconfigPaths,
    ]);
    if (registry.entries().some((entry) => entry.kind === "symlink"))
      return false;
    const errors: ParseError[] = [];
    const config = parse(
      await readContainedFile(registry, workspace.tsconfigPaths[0]!),
      errors,
      { allowTrailingComma: true },
    );
    if (
      errors.length ||
      !config ||
      typeof config !== "object" ||
      Object.keys(config).some(
        (key) => !["compilerOptions", "include"].includes(key),
      ) ||
      JSON.stringify(config.include) !== '["src"]'
    )
      return false;
    const options = config.compilerOptions;
    if (
      !options ||
      typeof options !== "object" ||
      Array.isArray(options) ||
      JSON.stringify(options.types) !== "[]" ||
      Object.keys(options).some(
        (key) =>
          ![
            "strict",
            "types",
            "target",
            "module",
            "lib",
            "noEmit",
            "skipLibCheck",
          ].includes(key),
      ) ||
      ts.convertCompilerOptionsFromJson(options, inspection.snapshotRoot).errors
        .length > 0
    )
      return false;
    let bytes = 0;
    for (const path of workspace.sourceFiles) {
      if (
        !path.startsWith(`${prefix}src/`) ||
        !/\.[cm]?ts$/u.test(path) ||
        /\.d\.[cm]?ts$/u.test(path)
      )
        return false;
      const source = await readContainedFile(registry, path);
      bytes += source.length * 2;
      if (source.length > 1024 * 1024 || bytes > 8 * 1024 * 1024) return false;
      const pre = ts.preProcessFile(source, true, true);
      if (
        pre.importedFiles.length ||
        pre.referencedFiles.length ||
        pre.typeReferenceDirectives.length ||
        pre.libReferenceDirectives.length
      )
        return false;
      const tree = ts.createSourceFile(
        path,
        source,
        ts.ScriptTarget.Latest,
        true,
      );
      if (!ts.isExternalModule(tree)) return false;
      let safe = true;
      const visit = (node: ts.Node): void => {
        if (
          ts.isModuleDeclaration(node) ||
          ts.isCallExpression(node) ||
          ts.isImportTypeNode(node) ||
          ts.isImportDeclaration(node) ||
          ts.isImportEqualsDeclaration(node) ||
          (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined)
        )
          safe = false;
        if (safe) ts.forEachChild(node, visit);
      };
      visit(tree);
      if (!safe) return false;
    }
    return true;
  } catch {
    return false;
  }
}
