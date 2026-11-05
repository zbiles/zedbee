import type { WorkspaceInspection } from "../../inspection/types.js";
import type { SnapshotRegistry } from "../../inspection/snapshot-registry.js";
import { compareCodeUnits } from "../../core/compare.js";

export interface FrameworkEntrypoints {
  readonly entry: readonly string[];
  readonly ignoreDependencies: readonly string[];
}

/** Default framework conventions, derived exclusively from captured owned files. */
export function resolveFrameworkEntrypoints(
  workspace: WorkspaceInspection,
  registry: SnapshotRegistry,
): FrameworkEntrypoints {
  if (!workspace.environments.includes("next"))
    return { entry: [], ignoreDependencies: [] };
  const prefix =
    workspace.relativeRoot === "." ? "" : `${workspace.relativeRoot}/`;
  const router = (name: string): string =>
    registry.resolve(`${prefix}${name}`)?.targetKind === "directory"
      ? name
      : `src/${name}`;
  const app = `${router("app")}/`;
  const pages = `${router("pages")}/`;
  const entry: string[] = [];
  for (const source of workspace.sourceFiles) {
    if (!source.startsWith(prefix)) continue;
    const path = source.slice(prefix.length);
    if (registry.resolve(source)?.targetKind !== "file") continue;
    let supported =
      /^next\.config\.(?:js|mjs|cjs|ts|mts)$/u.test(path) ||
      /^(?:src\/)?(?:instrumentation|instrumentation-client|middleware|proxy)\.(?:js|jsx|ts|tsx)$/u.test(
        path,
      );
    if (!/\.d\.[cm]?ts$/u.test(path)) {
      if (path.startsWith(pages) && /\.(?:js|jsx|ts|tsx)$/u.test(path))
        supported = true;
      if (path.startsWith(app)) {
        const route = path.slice(app.length);
        const parts = route.split("/");
        if (!parts.slice(0, -1).some((part) => part.startsWith("_"))) {
          supported ||=
            /(?:^|\/)(?:page|layout|route|template|default|error|loading|not-found|forbidden|unauthorized)\.(?:js|jsx|ts|tsx)$/u.test(
              route,
            ) ||
            /^(?:global-error|global-not-found)\.(?:js|jsx|ts|tsx)$/u.test(
              route,
            ) ||
            /^(?:\([^/]+\)\/)?(?:manifest|robots)\.(?:js|ts)$/u.test(route) ||
            /(?:^|\/)sitemap\.(?:js|ts)$/u.test(route) ||
            /(?:^|\/)(?:icon|apple-icon|opengraph-image|twitter-image)\.(?:js|jsx|ts|tsx)$/u.test(
              route,
            );
        }
      }
    }
    if (supported || path === "next-env.d.ts") entry.push(path);
  }
  return {
    entry: [...new Set(entry)].sort(compareCodeUnits),
    ignoreDependencies: entry.some((path) => path !== "next-env.d.ts")
      ? ["next"]
      : [],
  };
}
