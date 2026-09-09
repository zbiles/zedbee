import type * as NodeFs from "node:fs";
import { posix, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import {
  CapturedDependencies,
  type DependencyCaptureContext,
} from "../../cache/captured-dependencies.js";
import { DEPENDENCY_LIMITS } from "../../cache/dependency-inputs.js";
import { captureSnapshotRegistry } from "../../inspection/snapshot-registry.js";

export const VIRTUAL_ROOT = "/snapshot";
export const MANAGED_CONFIG = "/managed/knip.json";
const require = createRequire(import.meta.url);

/** One owned snapshot inventory, shared by JS reads and the WASI filesystem. */
export async function createKnipFilesystem(
  context: DependencyCaptureContext,
  snapshotRoot: string,
  config: unknown,
) {
  if (
    ![context.snapshots?.baselineDir, context.snapshots?.targetDir].includes(
      snapshotRoot,
    )
  )
    throw new TypeError("Invalid Knip snapshot owner");
  const registry = await captureSnapshotRegistry(snapshotRoot);
  const entries = registry.entries();
  if (entries.length > DEPENDENCY_LIMITS.probes)
    throw new RangeError("Knip snapshot capacity");
  const capture = new CapturedDependencies(context, true);
  const { memfs } = (await import(
    new URL(
      "./dist/fs.js",
      pathToFileURL(require.resolve("@napi-rs/wasm-runtime")),
    ).href
  )) as {
    memfs(): { fs: typeof NodeFs; vol: { reset(): void } };
  };
  const { fs, vol } = memfs();
  const virtual = (path: string) => posix.join(VIRTUAL_ROOT, path);
  let metadataBytes = 0;
  for (const entry of entries) {
    metadataBytes += Buffer.byteLength(entry.repositoryPath) + 256;
    if (metadataBytes > DEPENDENCY_LIMITS.metadataBytes)
      throw new RangeError("Knip inventory capacity");
    const path = virtual(entry.repositoryPath);
    if (entry.kind === "directory") {
      fs.mkdirSync(path, { recursive: true });
      // Listings close the captured inventory over every possible missing child.
      capture.directoryEntries(entry.absolutePath);
    } else if (entry.kind === "file") {
      fs.writeFileSync(path, "");
    }
  }
  for (const entry of entries) {
    if (entry.kind !== "symlink") continue;
    const target = relative(snapshotRoot, entry.canonicalPath)
      .split(sep)
      .join("/");
    fs.symlinkSync(virtual(target), virtual(entry.repositoryPath));
  }
  const managed = JSON.stringify(config);
  if (Buffer.byteLength(managed) > DEPENDENCY_LIMITS.fileBytes)
    throw new RangeError("Knip config capacity");
  fs.mkdirSync("/managed");
  fs.writeFileSync(MANAGED_CONFIG, managed);
  const hydrated = new Set<string>();
  const descriptors = new Set<number>();
  let closed = false;
  let incomplete = false;
  const denied = () =>
    Object.assign(new Error("Knip filesystem operation denied"), {
      code: "EACCES",
    });
  const hydrate = (argument: unknown) => {
    const path =
      argument instanceof URL
        ? fileURLToPath(argument)
        : typeof argument === "string"
          ? argument
          : undefined;
    if (path === undefined || !path.startsWith(`${VIRTUAL_ROOT}/`)) return;
    const relativePath = posix.relative(VIRTUAL_ROOT, path);
    if (relativePath.startsWith("../") || relativePath.includes("\\"))
      throw denied();
    const entry = registry.resolve(relativePath);
    if (entry?.targetKind !== "file") return;
    const bytes = capture.readBytes(
      resolve(snapshotRoot, relativePath),
      entry.canonicalPath,
    );
    if (hydrated.has(entry.canonicalPath)) return;
    const canonical = virtual(
      relative(snapshotRoot, entry.canonicalPath).split(sep).join("/"),
    );
    fs.writeFileSync(canonical, bytes);
    hydrated.add(entry.canonicalPath);
  };
  const forbidden =
    /^(?:write|append|truncate|ftruncate|mkdir|mkdtemp|unlink|rm|rmdir|rename|copy|cp|link|symlink|chmod|chown|lchmod|lchown|fchmod|fchown|utimes|lutimes|futimes|watch|unwatch|createWriteStream)/u;
  const wrap = <T extends object>(source: T): T =>
    new Proxy(source, {
      get(target, key) {
        const value = Reflect.get(target, key);
        if (typeof value !== "function") return value;
        const fn = (...args: unknown[]) => {
          if (closed || forbidden.test(String(key))) throw denied();
          if (key === "open") throw denied();
          if (key === "openSync") {
            if (args[1] !== "r" && args[1] !== 0) throw denied();
            if (descriptors.size >= 256)
              throw new RangeError("Knip descriptor capacity");
          }
          try {
            hydrate(args[0]);
          } catch (error) {
            incomplete = true;
            throw error;
          }
          const result = Reflect.apply(value, target, args);
          if (key === "openSync") descriptors.add(result as number);
          if (key === "closeSync") descriptors.delete(args[0] as number);
          return result;
        };
        if (key === "realpathSync") Object.assign(fn, { native: fn });
        return fn;
      },
    });
  const promises = wrap(fs.promises);
  const wrapped = wrap(fs);
  const provider = new Proxy(wrapped, {
    get(target, key) {
      return key === "promises" ? promises : Reflect.get(target, key);
    },
  });
  return {
    fs: provider,
    capture,
    assertComplete() {
      if (incomplete) throw new Error("Incomplete Knip filesystem capture");
    },
    close() {
      closed = true;
      for (const fd of descriptors) fs.closeSync(fd);
      descriptors.clear();
      hydrated.clear();
      vol.reset();
    },
  };
}
