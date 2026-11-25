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
