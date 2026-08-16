import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { relative } from "node:path";
import { execa } from "execa";
import {
  ManagedBinaryError,
  type ManagedBinary,
  type ManagedRunOptions,
  type ManagedRunResult,
} from "./types.js";

const ENVIRONMENT_ALLOWLIST = new Set([
  "COMSPEC",
  "LANG",
  "LC_ALL",
  "PATH",
  "PATHEXT",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "SystemRoot",
  "TEMP",
  "TMP",
  "TMPDIR",
  "WINDIR",
]);

function contained(root: string, path: string): boolean {
  const candidate = relative(root, path);
  return (
    candidate !== ".." &&
    !candidate.startsWith("../") &&
    !candidate.startsWith("..\\")
  );
}

function sanitizedEnvironment(
  binary: ManagedBinary,
  extra: Readonly<Record<string, string | undefined>> | undefined,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of ENVIRONMENT_ALLOWLIST) {
    const value = extra?.[name] ?? process.env[name];
    if (value !== undefined) result[name] = value;
  }
  if (binary.engine === "osv-scanner") {
    const database = extra?.OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY;
    if (database !== undefined) {
      result.OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY = database;
    }
  }
  return result;
}

function checksum(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

export async function runManagedBinary(
  binary: ManagedBinary,
  args: readonly string[],
  options: ManagedRunOptions,
): Promise<ManagedRunResult> {
  if (
    !Array.isArray(args) ||
    args.some(
      (argument) => typeof argument !== "string" || argument.includes("\0"),
    )
  ) {
    throw new ManagedBinaryError(
      "MANAGED_BINARY_FAILED",
      binary.engine,
      `Managed ${binary.engine} received invalid arguments.`,
    );
  }
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1) {
    throw new ManagedBinaryError(
      "MANAGED_BINARY_FAILED",
      binary.engine,
      `Managed ${binary.engine} received an invalid timeout.`,
    );
  }
  if (isAborted(options.signal)) {
    throw new ManagedBinaryError(
      "MANAGED_BINARY_ABORTED",
      binary.engine,
      `Managed ${binary.engine} was aborted.`,
    );
  }
  try {
    const packageRoot = await realpath(binary.packageRoot);
    const executablePath = await realpath(binary.executablePath);
    if (
      !contained(packageRoot, executablePath) ||
      checksum(await readFile(executablePath)) !== binary.executableSha256
    ) {
      throw new ManagedBinaryError(
        "MANAGED_BINARY_CHECKSUM_MISMATCH",
        binary.engine,
        `Managed ${binary.engine} failed checksum verification.`,
      );
    }
    if (
      (binary.configPath === undefined) !==
      (binary.configSha256 === undefined)
    ) {
      throw new ManagedBinaryError(
        "MANAGED_BINARY_CHECKSUM_MISMATCH",
        binary.engine,
        `Managed ${binary.engine} failed checksum verification.`,
      );
    }
    if (binary.configPath !== undefined && binary.configSha256 !== undefined) {
      const configPath = await realpath(binary.configPath);
      if (
        !contained(packageRoot, configPath) ||
        checksum(await readFile(configPath)) !== binary.configSha256
      ) {
        throw new ManagedBinaryError(
          "MANAGED_BINARY_CHECKSUM_MISMATCH",
          binary.engine,
          `Managed ${binary.engine} failed checksum verification.`,
        );
      }
    }
    const result = await execa(executablePath, [...args], {
      cwd: options.cwd,
      env: sanitizedEnvironment(binary, options.environment),
      extendEnv: false,
      shell: false,
      stdin: "ignore",
      forceKillAfterDelay: 2_000,
      reject: false,
      timeout: options.timeoutMs,
      ...(options.signal === undefined ? {} : { cancelSignal: options.signal }),
    });
    if (result.isCanceled || isAborted(options.signal)) {
      throw new ManagedBinaryError(
        "MANAGED_BINARY_ABORTED",
        binary.engine,
        `Managed ${binary.engine} was aborted.`,
      );
    }
    if (result.timedOut) {
      throw new ManagedBinaryError(
        "MANAGED_BINARY_TIMEOUT",
        binary.engine,
        `Managed ${binary.engine} timed out.`,
      );
    }
    const exitCode = result.exitCode ?? -1;
    const accepted = options.acceptedExitCodes ?? [0];
    if (!accepted.includes(exitCode)) {
      throw new ManagedBinaryError(
        "MANAGED_BINARY_FAILED",
        binary.engine,
        `Managed ${binary.engine} failed with exit code ${exitCode}.`,
        exitCode,
      );
    }
    return Object.freeze({
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode,
    });
  } catch (error) {
    if (error instanceof ManagedBinaryError) throw error;
    const candidate = error as {
      timedOut?: boolean;
      isCanceled?: boolean;
      exitCode?: number;
    };
    if (isAborted(options.signal) || candidate.isCanceled === true) {
      throw new ManagedBinaryError(
        "MANAGED_BINARY_ABORTED",
        binary.engine,
        `Managed ${binary.engine} was aborted.`,
      );
    }
    if (candidate.timedOut === true) {
      throw new ManagedBinaryError(
        "MANAGED_BINARY_TIMEOUT",
        binary.engine,
        `Managed ${binary.engine} timed out.`,
      );
    }
    throw new ManagedBinaryError(
      "MANAGED_BINARY_FAILED",
      binary.engine,
      `Managed ${binary.engine} could not be executed.`,
      candidate.exitCode,
    );
  }
}
