import { resolve } from "node:path";
import type { CapturedDependencies } from "../../cache/captured-dependencies.js";

/** Only Knip's manifest reader gets this JSON-only replacement for require. */
export function createPackageMetadataReader(
  capture: CapturedDependencies,
): (path: string) => { bin?: string | Record<string, string> } {
  return (path) => {
    // Virtual paths are POSIX on every host. No traversal, code, or arbitrary JSON.
    const match =
      /^\/snapshot\/(?:([^\\\0:]+)\/)?node_modules\/((?:@[^/]+\/)?[^/]+)\/package\.json$/u.exec(
        path,
      );
    if (
      !match ||
      path.length > 4096 ||
      /[\\\0:]/u.test(path) ||
      path
        .split("/")
        .slice(1)
        .some((part) => !part || part === "." || part === "..")
    )
      throw new TypeError("Invalid Knip package metadata path");
    const text = capture.readFile(
      resolve(
        capture.context.repositoryRoot,
        ...path.slice("/snapshot/".length).split("/"),
      ),
    );
    if (text === undefined) throw new Error("Package metadata unavailable");
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null || Array.isArray(value))
      throw new TypeError("Invalid package metadata");
    const bin: unknown = Reflect.get(value, "bin");
    if (typeof bin === "string") return { bin };
    if (typeof bin !== "object" || bin === null || Array.isArray(bin))
      return {};
    // Values are data only. Do not expose scripts, exports, or project plugins.
    return {
      bin: Object.fromEntries(
        Object.entries(bin).filter(
          ([name, target]) =>
            /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/u.test(name) &&
            typeof target === "string",
        ),
      ),
    };
  };
}
