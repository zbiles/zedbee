import { extname } from "node:path";

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
  return PARSERS[extname(file).toLowerCase() as SupportedExtension];
}

export function isSupportedPrettierPath(file: string): boolean {
  return prettierParserFor(file) !== undefined;
}
