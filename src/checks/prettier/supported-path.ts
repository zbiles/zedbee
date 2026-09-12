import { basename, extname } from "node:path";

// Package managers own these generated files; other checks still inspect them.
const GENERATED_LOCKFILES: ReadonlySet<string> = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
]);

const PARSERS = {
  ".css": "css",
  ".js": "babel",
  ".json": "json",
  ".jsonc": "json",
  ".jsx": "babel",
  ".md": "markdown",
  ".markdown": "markdown",
  ".ts": "typescript",
  ".tsx": "typescript",
  ".yaml": "yaml",
  ".yml": "yaml",
} as const;

type SupportedExtension = keyof typeof PARSERS;

export type PrettierParser = (typeof PARSERS)[SupportedExtension];

export function prettierParserFor(file: string): PrettierParser | undefined {
  if (GENERATED_LOCKFILES.has(basename(file.replaceAll("\\", "/")))) {
    return undefined;
  }
  return PARSERS[extname(file).toLowerCase() as SupportedExtension];
}

export function isSupportedPrettierPath(file: string): boolean {
  return prettierParserFor(file) !== undefined;
}
