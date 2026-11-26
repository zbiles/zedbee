import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Anchor to this package in both source tests and compiled installations. Knip
// lives outside node_modules so its Zod dependency uses our private runtime
// without making npm replace an application's compatible Zod installation.
export const managedKnipEntry = new URL(
  "../../../dist/vendor/knip/dist/index.js",
  import.meta.url,
).href;

/** File URL of a module inside the pinned Knip package's dist directory. */
export function pinnedKnipModuleUrl(...segments: string[]): string {
  return pathToFileURL(
    join(dirname(fileURLToPath(managedKnipEntry)), ...segments),
  ).href;
}
