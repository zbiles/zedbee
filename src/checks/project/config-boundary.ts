import {
  chmod,
  lstat,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  rmdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, sep } from "node:path";

const MANAGED_CONFIG_PREFIX = "zedbee-managed-config-";
const MANAGED_OUTPUT_PREFIX = "zedbee-managed-output-";
const MANAGED_CONFIG_NAME = /^[a-z0-9][a-z0-9-]*$/u;
const MANAGED_ARTIFACT_NAME = /^[a-z0-9][a-z0-9._-]*$/u;
const MAX_MANAGED_JSON_BYTES = 64 * 1024 * 1024;

export interface ManagedConfigFile {
  readonly path: string;
  cleanup(): Promise<void>;
}

export interface ManagedOutputDirectory {
  readonly path: string;
  readJson(name: string): Promise<unknown>;
  readText(name: string): Promise<string>;
  cleanup(): Promise<void>;
}

export class ManagedConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManagedConfigError";
  }
}

interface FileIdentity {
  readonly device: bigint;
  readonly inode: bigint;
}

function fileIdentity(metadata: { dev: bigint; ino: bigint }): FileIdentity {
  return { device: metadata.dev, inode: metadata.ino };
}

function hasIdentity(
  metadata: { dev: bigint; ino: bigint },
  expected: FileIdentity,
): boolean {
  return metadata.dev === expected.device && metadata.ino === expected.inode;
}

function isContainedBy(parent: string, child: string): boolean {
  const pathFromParent = relative(parent, child);
  return (
    pathFromParent !== "" &&
    !isAbsolute(pathFromParent) &&
    pathFromParent !== ".." &&
    !pathFromParent.startsWith(`..${sep}`)
  );
}

async function validateManagedDirectory(path: string): Promise<string> {
  const canonicalTempRoot = await realpath(tmpdir());
  const metadata = await lstat(path);
  const canonicalPath = await realpath(path);
  if (
    metadata.isSymbolicLink() ||
    !metadata.isDirectory() ||
    !isContainedBy(canonicalTempRoot, canonicalPath) ||
    (!basename(canonicalPath).startsWith(MANAGED_CONFIG_PREFIX) &&
      !basename(canonicalPath).startsWith(MANAGED_OUTPUT_PREFIX))
  ) {
    throw new ManagedConfigError(
      "Zedbee refused to use a managed config path outside its private temporary directory.",
    );
  }
  return canonicalPath;
}

function validateArtifactName(name: string): void {
  if (
    !MANAGED_ARTIFACT_NAME.test(name) ||
    name.includes("..") ||
    name.includes("/") ||
    name.includes("\\")
  ) {
    throw new ManagedConfigError(
      "Zedbee rejected an unsafe managed artifact name.",
    );
  }
}

export async function createManagedOutputDirectory(
  name: string,
  expectedArtifacts: readonly string[],
): Promise<ManagedOutputDirectory> {
  if (!MANAGED_CONFIG_NAME.test(name)) {
    throw new ManagedConfigError(
      "Zedbee rejected an unsafe managed output name.",
    );
  }
  if (!Array.isArray(expectedArtifacts) || expectedArtifacts.length === 0) {
    throw new ManagedConfigError("Zedbee expected managed output artifacts.");
  }
  for (const artifact of expectedArtifacts) validateArtifactName(artifact);
  const allowed = new Set(expectedArtifacts);
  if (allowed.size !== expectedArtifacts.length) {
    throw new ManagedConfigError(
      "Zedbee rejected duplicate managed artifacts.",
    );
  }

  const canonicalTempRoot = await realpath(tmpdir());
  const temporaryDirectory = await mkdtemp(
    join(canonicalTempRoot, `${MANAGED_OUTPUT_PREFIX}${name}-`),
  );
  let canonicalDirectory: string;
  let identity: FileIdentity;
  try {
    await chmod(temporaryDirectory, 0o700);
    canonicalDirectory = await validateManagedDirectory(temporaryDirectory);
    identity = fileIdentity(await lstat(canonicalDirectory, { bigint: true }));
  } catch (error) {
    await rmdir(temporaryDirectory);
    throw error;
  }
  let cleaned = false;

  const readArtifact = async (artifactName: string): Promise<string> => {
    validateArtifactName(artifactName);
    if (!allowed.has(artifactName)) {
      throw new ManagedConfigError(
        "Zedbee rejected an unexpected managed artifact.",
      );
    }
    await validateDirectoryIdentity();
    const artifactPath = join(canonicalDirectory, artifactName);
    const metadata = await lstat(artifactPath, { bigint: true });
    if (
      metadata.isSymbolicLink() ||
      !metadata.isFile() ||
      metadata.size > BigInt(MAX_MANAGED_JSON_BYTES) ||
      (await realpath(artifactPath)) !== artifactPath
    ) {
      throw new ManagedConfigError(
        "Zedbee rejected an unsafe managed artifact.",
      );
    }
    const handle = await open(artifactPath, "r");
    try {
      const opened = await handle.stat({ bigint: true });
      if (
        !opened.isFile() ||
        opened.size > BigInt(MAX_MANAGED_JSON_BYTES) ||
        !hasIdentity(opened, fileIdentity(metadata))
      ) {
        throw new ManagedConfigError(
          "Zedbee rejected a managed artifact whose identity changed.",
        );
      }
      return handle.readFile("utf8");
    } finally {
      await handle.close();
    }
  };

  const validateDirectoryIdentity = async () => {
    const metadata = await lstat(canonicalDirectory, { bigint: true });
    if (
      metadata.isSymbolicLink() ||
      !metadata.isDirectory() ||
      !hasIdentity(metadata, identity) ||
      (await validateManagedDirectory(canonicalDirectory)) !==
        canonicalDirectory
    ) {
      throw new ManagedConfigError(
        "Zedbee refused a managed output directory whose identity changed.",
      );
    }
  };

  return {
    path: canonicalDirectory,
    async readJson(artifactName) {
      return JSON.parse(await readArtifact(artifactName)) as unknown;
    },
    async readText(artifactName) {
      return readArtifact(artifactName);
    },
    async cleanup() {
      if (cleaned) return;
      try {
        await validateDirectoryIdentity();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          cleaned = true;
          return;
        }
        throw error;
      }
      const entries = await readdir(canonicalDirectory);
      if (entries.some((entry) => !allowed.has(entry))) {
        throw new ManagedConfigError(
          "Zedbee refused to clean a managed output directory with unexpected artifacts.",
        );
      }
      for (const entry of entries) {
        const metadata = await lstat(join(canonicalDirectory, entry), {
          bigint: true,
        });
        if (metadata.isSymbolicLink() || !metadata.isFile()) {
          throw new ManagedConfigError(
            "Zedbee refused to clean an unsafe managed artifact.",
          );
        }
      }
      await rm(canonicalDirectory, { recursive: true, force: false });
      cleaned = true;
    },
  };
}

export async function writeManagedJsonConfig(
  name: string,
  value: unknown,
): Promise<ManagedConfigFile> {
  if (!MANAGED_CONFIG_NAME.test(name)) {
    throw new ManagedConfigError(
      "Zedbee rejected an unsafe managed config name.",
    );
  }

  const encoded = JSON.stringify(value, null, 2);
  if (encoded === undefined) {
    throw new ManagedConfigError(
      "Zedbee could not serialize managed JSON config.",
    );
  }
  const expectedContents = `${encoded}\n`;
  const expectedByteLength = BigInt(Buffer.byteLength(expectedContents, "utf8"));

  const canonicalTempRoot = await realpath(tmpdir());
  const temporaryDirectory = await mkdtemp(
    join(canonicalTempRoot, MANAGED_CONFIG_PREFIX),
  );
  let canonicalDirectory: string | undefined;
  let configPath: string | undefined;
  let directoryIdentity: FileIdentity | undefined;
  let configIdentity: FileIdentity | undefined;
  let cleaned = false;

  const cleanup = async (): Promise<void> => {
    if (
      cleaned ||
      canonicalDirectory === undefined ||
      configPath === undefined ||
      directoryIdentity === undefined ||
      configIdentity === undefined
    ) {
      return;
    }

    let directoryMetadata;
    try {
      directoryMetadata = await lstat(canonicalDirectory, { bigint: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        cleaned = true;
        return;
      }
      throw error;
    }

    const validatedDirectory =
      await validateManagedDirectory(canonicalDirectory);
    const configMetadata = await lstat(configPath, { bigint: true });
    const entries = await readdir(canonicalDirectory);
    if (
      validatedDirectory !== canonicalDirectory ||
      !hasIdentity(directoryMetadata, directoryIdentity) ||
      directoryMetadata.isSymbolicLink() ||
      !directoryMetadata.isDirectory() ||
      !hasIdentity(configMetadata, configIdentity) ||
      configMetadata.isSymbolicLink() ||
      !configMetadata.isFile() ||
      entries.length !== 1 ||
      entries[0] !== basename(configPath)
    ) {
      throw new ManagedConfigError(
        "Zedbee refused to clean a managed config path whose identity changed.",
      );
    }
    if (
      configMetadata.size !== expectedByteLength ||
      (await readFile(configPath, "utf8")) !== expectedContents
    ) {
      throw new ManagedConfigError(
        "Zedbee refused to clean a managed config whose contents changed.",
      );
    }

    await rm(canonicalDirectory, { recursive: true, force: false });
    cleaned = true;
  };

  try {
    await chmod(temporaryDirectory, 0o700);
    canonicalDirectory = await validateManagedDirectory(temporaryDirectory);
    directoryIdentity = fileIdentity(
      await lstat(canonicalDirectory, { bigint: true }),
    );
    configPath = join(canonicalDirectory, `${name}.json`);
    const handle = await open(configPath, "wx", 0o600);
    try {
      configIdentity = fileIdentity(await handle.stat({ bigint: true }));
      await handle.writeFile(expectedContents, "utf8");
    } finally {
      await handle.close();
    }

    return { path: configPath, cleanup };
  } catch (error) {
    if (
      canonicalDirectory !== undefined &&
      configPath !== undefined &&
      directoryIdentity !== undefined &&
      configIdentity !== undefined
    ) {
      await cleanup();
    } else if (
      canonicalDirectory !== undefined &&
      directoryIdentity !== undefined
    ) {
      const metadata = await lstat(canonicalDirectory, { bigint: true });
      const entries = await readdir(canonicalDirectory);
      if (
        metadata.isSymbolicLink() ||
        !metadata.isDirectory() ||
        !hasIdentity(metadata, directoryIdentity) ||
        entries.length !== 0
      ) {
        throw new ManagedConfigError(
          "Zedbee refused to clean an incomplete managed config path whose identity changed.",
        );
      }
      await rmdir(canonicalDirectory);
    } else {
      await rmdir(temporaryDirectory);
    }
    throw error;
  }
}
