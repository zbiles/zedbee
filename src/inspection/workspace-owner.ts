import { compareCodeUnits } from "../core/compare.js";

/** A repository root owns unmatched members. Nested workspaces take precedence. */
export function workspaceContainsFile(root: string, path: string): boolean {
  return root === "." || path.startsWith(`${root}/`);
}

export function owningWorkspace<T extends { readonly relativeRoot: string }>(
  workspaces: readonly T[],
  path: string,
): T | undefined {
  let owner: T | undefined;
  for (const workspace of workspaces) {
    const root = workspace.relativeRoot;
    if (
      workspaceContainsFile(root, path) &&
      (!owner ||
        (root !== "." && workspaceContainsFile(owner.relativeRoot, root)))
    )
      owner = workspace;
  }
  return owner;
}

type PhysicalWorkspace = {
  readonly relativeRoot: string;
  readonly canonicalRelativeRoot?: string;
};
export function physicalWorkspaceRoot(workspace: PhysicalWorkspace): string {
  return workspace.canonicalRelativeRoot ?? workspace.relativeRoot;
}

/** Deepest physical scope, preferring a direct declaration over a same-root alias. */
export function physicalWorkspaceOrder<T extends PhysicalWorkspace>(
  workspaces: readonly T[],
): readonly T[] {
  return [...workspaces].sort((a, b) => {
    const ar = physicalWorkspaceRoot(a);
    const br = physicalWorkspaceRoot(b);
    return (
      Number(ar === ".") - Number(br === ".") ||
      br.split("/").length - ar.split("/").length ||
      Number(ar !== a.relativeRoot) - Number(br !== b.relativeRoot) ||
      compareCodeUnits(a.relativeRoot, b.relativeRoot)
    );
  });
}
