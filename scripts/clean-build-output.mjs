import { lstatSync, realpathSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

export function cleanBuildOutput(root = process.cwd()) {
  const canonicalRoot = realpathSync(root);
  const output = join(canonicalRoot, "dist");
  let metadata;
  try {
    metadata = lstatSync(output);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (
    metadata.isSymbolicLink() ||
    !metadata.isDirectory() ||
    realpathSync(output) !== output ||
    dirname(output) !== canonicalRoot ||
    basename(output) !== "dist"
  ) {
    throw new Error("Refused to clean an invalid build-output directory.");
  }
  rmSync(output, { recursive: true, force: false });
}

const entryPoint = process.argv[1]
  ? pathToFileURL(realpathSync(process.argv[1])).href
  : undefined;
if (entryPoint === import.meta.url) {
  try {
    cleanBuildOutput();
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Build-output cleanup failed."}\n`,
    );
    process.exitCode = 1;
  }
}
