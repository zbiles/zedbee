import type {
  ManagedArchitecture,
  ManagedEngine,
  ManagedPlatform,
} from "./types.js";

const SUPPORTED = new Set([
  "darwin:arm64",
  "darwin:x64",
  "linux:arm64",
  "linux:x64",
  "win32:x64",
]);

export function managedPackageName(
  engine: ManagedEngine,
  platform: string,
  arch: string,
): string | undefined {
  if (!SUPPORTED.has(`${platform}:${arch}`)) return undefined;
  return `@zedbee/${engine}-${platform}-${arch}`;
}

export function isManagedPlatform(
  platform: string,
): platform is ManagedPlatform {
  return platform === "darwin" || platform === "linux" || platform === "win32";
}

export function isManagedArchitecture(
  arch: string,
): arch is ManagedArchitecture {
  return arch === "arm64" || arch === "x64";
}
