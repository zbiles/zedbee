import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { managedPackageName } from "./platform.js";
import {
  ManagedBinaryError,
  type ManagedBinary,
  type ManagedEngine,
} from "./types.js";

const sha256 = (value: Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
const sha = z.string().regex(/^[a-f0-9]{64}$/u);
const embeddedManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    engine: z.enum(["gitleaks", "osv-scanner"]),
    version: z.string().trim().min(1),
    platform: z.string().trim().min(1),
    arch: z.string().trim().min(1),
    executablePath: z.string().trim().min(1),
    executableSha256: sha,
    configPath: z.string().trim().min(1).optional(),
    configSha256: sha.optional(),
  })
  .strict()
  .refine(
    (manifest) =>
      (manifest.configPath === undefined) ===
      (manifest.configSha256 === undefined),
  );

export interface ResolveManagedBinaryOptions {
  readonly resolvePackageJson?: (specifier: string) => string | Promise<string>;
}

function unavailable(
  engine: ManagedEngine,
  platform: string,
  arch: string,
): ManagedBinaryError {
  return new ManagedBinaryError(
    "MANAGED_BINARY_UNAVAILABLE",
    engine,
    `Managed ${engine} is unavailable for ${platform} ${arch}.`,
  );
}

function contained(root: string, path: string): boolean {
  const candidate = relative(root, path);
  return (
    candidate !== ".." &&
    !candidate.startsWith("../") &&
    !candidate.startsWith("..\\")
  );
}

function filePath(resolved: string): string {
  return resolved.startsWith("file:") ? fileURLToPath(resolved) : resolved;
}

async function defaultResolve(specifier: string): Promise<string> {
  return import.meta.resolve(specifier);
}

export async function resolveManagedBinary(
  engine: ManagedEngine,
  platform: string = process.platform,
  arch: string = process.arch,
  options: ResolveManagedBinaryOptions = {},
): Promise<ManagedBinary> {
  const packageName = managedPackageName(engine, platform, arch);
  if (packageName === undefined) throw unavailable(engine, platform, arch);
  try {
    const packageJsonPath = filePath(
      await (options.resolvePackageJson ?? defaultResolve)(
        `${packageName}/package.json`,
      ),
    );
    const packageRoot = await realpath(dirname(packageJsonPath));
    const manifestPath = await realpath(resolve(packageRoot, "manifest.json"));
    if (!contained(packageRoot, manifestPath))
      throw unavailable(engine, platform, arch);
    const manifest = embeddedManifestSchema.parse(
      JSON.parse(await readFile(manifestPath, "utf8")),
    );
    if (
      manifest.engine !== engine ||
      manifest.platform !== platform ||
      manifest.arch !== arch
    ) {
      throw unavailable(engine, platform, arch);
    }
    const executablePath = await realpath(
      resolve(packageRoot, manifest.executablePath),
    );
    if (!contained(packageRoot, executablePath))
      throw unavailable(engine, platform, arch);
    if (sha256(await readFile(executablePath)) !== manifest.executableSha256) {
      throw new ManagedBinaryError(
        "MANAGED_BINARY_CHECKSUM_MISMATCH",
        engine,
        `Managed ${engine} failed checksum verification.`,
      );
    }
    let configPath: string | undefined;
    if (
      manifest.configPath !== undefined &&
      manifest.configSha256 !== undefined
    ) {
      configPath = await realpath(resolve(packageRoot, manifest.configPath));
      if (
        !contained(packageRoot, configPath) ||
        sha256(await readFile(configPath)) !== manifest.configSha256
      ) {
        throw new ManagedBinaryError(
          "MANAGED_BINARY_CHECKSUM_MISMATCH",
          engine,
          `Managed ${engine} failed checksum verification.`,
        );
      }
    }
    return Object.freeze({
      engine,
      version: manifest.version,
      platform,
      arch,
      packageName,
      packageRoot,
      manifestPath,
      executablePath,
      executableSha256: manifest.executableSha256,
      ...(configPath === undefined || manifest.configSha256 === undefined
        ? {}
        : { configPath, configSha256: manifest.configSha256 }),
    });
  } catch (error) {
    if (error instanceof ManagedBinaryError) throw error;
    throw unavailable(engine, platform, arch);
  }
}
