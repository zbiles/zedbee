import { lstat, mkdir, realpath, symlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ImportSourceCapture } from "./project-import-capture.js";
import {
  ImportCaptureError,
  readBoundedImportFile,
} from "./project-import-capture.js";

const PACKAGE_NAME = /^(?:@[a-z0-9_~.-]+\/)?[a-z0-9_~.-]+$/iu;
export function isImportPackageName(name: string): boolean {
  return (
    PACKAGE_NAME.test(name) &&
    !name.split("/").some((part) => part === "." || part === "..")
  );
}
const MAX_PACKAGES = 1024;
const MAX_LOOKUP_DEPTH = 64;

/** Follow only manifest-declared installed package edges, within shared budgets. */
export function captureImportDependencies(
  capture: ImportSourceCapture,
  signal: AbortSignal,
) {
  const packages = new Map<string, string>();
  let edges = 0;
  const find = async (
    source: string,
    name: string,
  ): Promise<string | undefined> => {
    let directory = source;
    for (let depth = 0; depth < MAX_LOOKUP_DEPTH; depth++) {
      signal.throwIfAborted();
      const candidate = join(directory, "node_modules", name);
      const metadata = await lstat(candidate).catch(() => undefined);
      if (metadata?.isDirectory() || metadata?.isSymbolicLink())
        return candidate;
      const parent = dirname(directory);
      if (parent === directory) return undefined;
      directory = parent;
    }
    throw new ImportCaptureError();
  };
  const copy = async (
    source: string,
    destination: string,
    key: string,
  ): Promise<void> => {
    signal.throwIfAborted();
    const canonical = await realpath(source);
    const existing = packages.get(canonical);
    if (existing !== undefined) {
      if (existing !== destination) {
        await mkdir(dirname(destination), { recursive: true });
        await symlink(
          existing,
          destination,
          process.platform === "win32" ? "junction" : "dir",
        );
      }
      return;
    }
    if (packages.size >= MAX_PACKAGES) throw new ImportCaptureError();
    packages.set(canonical, destination);
    await capture.copy(canonical, destination, key);
    const manifestPath = join(canonical, "package.json");
    let manifest: Record<string, unknown>;
    try {
      manifest = JSON.parse(
        (await readBoundedImportFile(manifestPath, canonical)).toString("utf8"),
      ) as Record<string, unknown>;
    } catch {
      throw new ImportCaptureError();
    }
    const names = new Set<string>();
    for (const section of [
      "dependencies",
      "optionalDependencies",
      "peerDependencies",
    ]) {
      const declarations = manifest[section];
      if (
        typeof declarations !== "object" ||
        declarations === null ||
        Array.isArray(declarations)
      )
        continue;
      for (const name of Object.keys(declarations)) {
        if (!isImportPackageName(name)) throw new ImportCaptureError();
        names.add(name);
        if (names.size > MAX_PACKAGES) throw new ImportCaptureError();
      }
    }
    for (const name of [...names].sort()) {
      if (++edges > 4096) throw new ImportCaptureError();
      const installed = await find(canonical, name);
      if (installed === undefined) continue; // Missing optional/peer packages stay unavailable.
      await capture.recordLink(
        `${key}/node_modules/${name}`,
        installed,
        await realpath(installed),
      );
      await copy(
        installed,
        join(destination, "node_modules", name),
        `${key}/node_modules/${name}`,
      );
    }
  };
  return copy;
}
