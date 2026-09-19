import { posix } from "node:path";
import { readContainedFile } from "../inspection/read-json.js";
import type { SnapshotRegistry } from "../inspection/snapshot-registry.js";
import type { FormattingSettings } from "../checks/prettier/settings.js";

const EDITORCONFIG_MAX_BYTES = 256 * 1024;

type EditorConfigKey =
  | "indent_style"
  | "indent_size"
  | "max_line_length"
  | "end_of_line";

const EDITORCONFIG_KEYS: ReadonlySet<string> = new Set<EditorConfigKey>([
  "indent_style",
  "indent_size",
  "max_line_length",
  "end_of_line",
]);

interface ParsedEditorConfig {
  readonly root: boolean;
  readonly settings: Partial<FormattingSettings>;
}

function parseEditorConfig(contents: string): ParsedEditorConfig {
  let root = false;
  const settings: Partial<FormattingSettings> = {};
  let appliesToAll = false;
  for (const rawLine of contents.split(/\r?\n|\r/u)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;
    if (line.startsWith("[") && line.endsWith("]")) {
      const section = line.slice(1, -1).trim();
      appliesToAll = section === "*" || section === "*.*";
      continue;
    }
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (key === "root") {
      if (value.toLowerCase() === "true") root = true;
      continue;
    }
    if (!appliesToAll || !EDITORCONFIG_KEYS.has(key)) continue;
    switch (key) {
      case "indent_style":
        if (value === "tab") settings.useTabs = true;
        else if (value === "space") settings.useTabs = false;
        break;
      case "indent_size":
      case "max_line_length": {
        const parsed = Number(value);
        if (Number.isSafeInteger(parsed) && parsed > 0) {
          if (key === "indent_size") settings.tabWidth = parsed;
          else settings.printWidth = parsed;
        }
        break;
      }
      case "end_of_line":
        if (value === "lf" || value === "crlf" || value === "cr") {
          settings.endOfLine = value;
        }
        break;
    }
  }
  return { root, settings };
}

function parentDirectory(directory: string): string | undefined {
  if (directory === ".") return undefined;
  const parent = posix.dirname(directory);
  return parent === "" ? "." : parent;
}

/**
 * Data-only EditorConfig values applicable to a project. Values from the
 * configuration file nearest to the project win over ancestor files, and a
 * `root = true` file bounds the upward search. Sections other than `[*]` and
 * `[*.*]` are ignored so the copy never invents per-path policy.
 */
export async function editorConfigSettings(
  registry: SnapshotRegistry,
  projectRoot: string,
): Promise<Partial<FormattingSettings>> {
  const chain: string[] = [];
  let current: string | undefined = projectRoot === "" ? "." : projectRoot;
  while (current !== undefined) {
    chain.unshift(current);
    current = parentDirectory(current);
  }
  const collected: Partial<FormattingSettings>[] = [];
  for (const directory of [...chain].reverse()) {
    const path =
      directory === "." ? ".editorconfig" : posix.join(directory, ".editorconfig");
    if (registry.resolve(path)?.targetKind !== "file") continue;
    let contents: string;
    try {
      contents = await readContainedFile(registry, path, {
        maxBytes: EDITORCONFIG_MAX_BYTES,
      });
    } catch {
      continue;
    }
    const parsed = parseEditorConfig(contents);
    collected.unshift(parsed.settings);
    if (parsed.root) break;
  }
  const settings: Partial<FormattingSettings> = {};
  // collected is ordered farthest to nearest; applying in order makes the
  // nearest configuration file win for every key it specifies.
  for (const entry of collected) {
    Object.assign(settings, entry);
  }
  return settings;
}
