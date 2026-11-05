import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  opendir,
  readlink,
  realpath,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { isContainedPath } from "../../inspection/read-json.js";

export interface ImportCaptureProvenance {
  readonly version: 1;
  readonly sha256: string;
  readonly configPaths: readonly string[];
}
const MAX_BYTES = 128 * 1024 * 1024;
const MAX_ENTRIES = 20_000;
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const OMITTED = new Set([
  ".git",
  "node_modules",
  ".cache",
  ".next",
  ".turbo",
  "coverage",
]);

export class ImportCaptureError extends Error {
  constructor() {
    super(
      "The project configuration inputs cannot be captured within the supported bounded layout; one-time import is unavailable.",
    );
    this.name = "ImportCaptureError";
  }
}

/** Refuse symlink substitutions and growth without ever reading beyond the cap. */
export async function readBoundedImportFile(
  source: string,
  root: string,
): Promise<Buffer> {
  const parent = await realpath(dirname(source));
  if (!isContainedPath(root, parent)) throw new ImportCaptureError();
  const handle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > MAX_FILE_BYTES)
      throw new ImportCaptureError();
    const buffer = Buffer.alloc(before.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        offset,
        buffer.length - offset,
        offset,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const after = await handle.stat();
    const named = await lstat(source);
    if (
      offset !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      named.isSymbolicLink() ||
      named.dev !== before.dev ||
      named.ino !== before.ino ||
      (await realpath(dirname(source))) !== parent
    )
      throw new ImportCaptureError();
    return buffer.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

async function directoryNames(source: string): Promise<string[]> {
  const names: string[] = [];
  const directory = await opendir(source);
  let seen = 0;
  for await (const entry of directory) {
    if (++seen > MAX_ENTRIES) throw new ImportCaptureError();
    if (!OMITTED.has(entry.name)) names.push(entry.name);
  }
  return names.sort();
}

/** One accumulator is shared by repository files and every declared package. */
export function createImportSourceCapture(
  signal: AbortSignal,
  configPaths: readonly string[] = [],
) {
  const sources = new Map<
    string,
    { source: string; sha256: string; root: string; real: string }
  >();
  let bytes = 0;
  let entries = 0;
  const record = async (
    key: string,
    source: string,
    data: Buffer | string,
    root: string,
  ): Promise<void> => {
    if (++entries > MAX_ENTRIES) throw new ImportCaptureError();
    sources.set(key, {
      source,
      root,
      real: await realpath(source),
      sha256: createHash("sha256").update(data).digest("hex"),
    });
  };
  const copy = async (
    sourceRoot: string,
    destinationRoot: string,
    keyRoot: string,
  ): Promise<void> => {
    const canonicalRoot = await realpath(sourceRoot);
    const walk = async (source: string, destination: string): Promise<void> => {
      signal.throwIfAborted();
      const metadata = await lstat(source);
      if (metadata.isSymbolicLink()) {
        // Never introduce a live link or traverse outside the approved root.
        const target = await realpath(source);
        if (!isContainedPath(canonicalRoot, target))
          throw new ImportCaptureError();
        const targetMetadata = await lstat(target);
        if (!targetMetadata.isFile()) throw new ImportCaptureError();
        await record(
          `${keyRoot}/${relative(sourceRoot, source)}#link`,
          source,
          await readlink(source),
          canonicalRoot,
        );
        await mkdir(dirname(destination), { recursive: true });
        const mirroredTarget = join(
          destinationRoot,
          relative(canonicalRoot, target),
        );
        await symlink(
          relative(dirname(destination), mirroredTarget),
          destination,
          "file",
        );
        return;
      }
      if (metadata.isDirectory()) {
        if (!isContainedPath(canonicalRoot, await realpath(source)))
          throw new ImportCaptureError();
        const children = await directoryNames(source);
        const after = await lstat(source);
        if (
          after.isSymbolicLink() ||
          metadata.dev !== after.dev ||
          metadata.ino !== after.ino
        )
          throw new ImportCaptureError();
        await record(
          `${keyRoot}/${relative(sourceRoot, source)}#directory`,
          source,
          children.join("\0"),
          canonicalRoot,
        );
        for (const child of children)
          await walk(join(source, child), join(destination, child));
        return;
      }
      if (!metadata.isFile()) throw new ImportCaptureError();
      await file(
        source,
        destination,
        `${keyRoot}/${relative(sourceRoot, source)}`,
      );
    };
    const file = async (
      source: string,
      destination: string,
      key: string,
    ): Promise<void> => {
      const size = (await lstat(source)).size;
      if (size > MAX_FILE_BYTES || (bytes += size) > MAX_BYTES)
        throw new ImportCaptureError();
      const data = await readBoundedImportFile(source, canonicalRoot);
      if (data.length !== size) throw new ImportCaptureError();
      await record(key, source, data, canonicalRoot);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, data, { mode: 0o600 });
    };
    await walk(sourceRoot, destinationRoot);
  };
  return {
    copy,
    async recordLink(key: string, source: string, target: string) {
      await record(`${key}#target`, source, target, target);
    },
    provenance(): ImportCaptureProvenance {
      const hash = createHash("sha256");
      for (const [key, value] of [...sources].sort(([a], [b]) =>
        a < b ? -1 : a > b ? 1 : 0,
      ))
        hash.update(key).update("\0").update(value.sha256).update("\0");
      return Object.freeze({
        version: 1,
        sha256: hash.digest("hex"),
        configPaths: Object.freeze([...configPaths].sort()),
      });
    },
    /** Recheck the actual captured inputs, including directory membership. */
    async verify(): Promise<void> {
      for (const [key, value] of sources) {
        signal.throwIfAborted();
        if ((await realpath(value.source)) !== value.real)
          throw new ImportCaptureError();
        let data: Buffer | string;
        if (key.endsWith("#target")) data = await realpath(value.source);
        else if (key.endsWith("#link")) data = await readlink(value.source);
        else if (key.endsWith("#directory")) {
          if (!(await lstat(value.source)).isDirectory())
            throw new ImportCaptureError();
          data = (await directoryNames(value.source)).join("\0");
        } else data = await readBoundedImportFile(value.source, value.root);
        if (createHash("sha256").update(data).digest("hex") !== value.sha256)
          throw new ImportCaptureError();
      }
    },
  };
}

export type ImportSourceCapture = ReturnType<typeof createImportSourceCapture>;
