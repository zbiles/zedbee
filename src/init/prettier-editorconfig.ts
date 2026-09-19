import { posix } from "node:path";
import type { ImportedFormattingOverride } from "../checks/prettier/project-types.js";
import type { FormattingSettings } from "../checks/prettier/settings.js";
import { readContainedFile } from "../inspection/read-json.js";
import type { SnapshotRegistry } from "../inspection/snapshot-registry.js";

const EDITORCONFIG_MAX_BYTES = 256 * 1024;

interface EditorConfigSection {
  readonly pattern: string;
  readonly settings: Partial<FormattingSettings>;
}

interface ParsedEditorConfig {
  readonly root: boolean;
  readonly sections: readonly EditorConfigSection[];
}

function applySetting(
  settings: Partial<FormattingSettings>,
  key: string,
  value: string,
): void {
  switch (key) {
    case "indent_style":
      if (value === "tab") settings.useTabs = true;
      else if (value === "space") settings.useTabs = false;
      break;
    case "indent_size":
    case "tab_width": {
      if (value === "tab") {
        if (key === "indent_size") settings.useTabs = true;
        break;
      }
      const parsed = Number(value);
      if (Number.isSafeInteger(parsed) && parsed > 0) settings.tabWidth = parsed;
      break;
    }
    case "max_line_length": {
      const parsed = Number(value);
      if (Number.isSafeInteger(parsed) && parsed > 0) settings.printWidth = parsed;
      break;
    }
    case "end_of_line":
      if (value === "lf" || value === "crlf" || value === "cr") {
        settings.endOfLine = value;
      }
      break;
  }
}

function parseEditorConfig(contents: string): ParsedEditorConfig {
  let root = false;
  let current: { pattern: string; settings: Partial<FormattingSettings> } | undefined;
  const sections: { pattern: string; settings: Partial<FormattingSettings> }[] = [];
  for (const rawLine of contents.split(/\r?\n|\r/u)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;
    if (line.startsWith("[") && line.endsWith("]")) {
      current = { pattern: line.slice(1, -1).trim(), settings: {} };
      sections.push(current);
      continue;
    }
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim().toLowerCase();
    if (current === undefined) {
      if (key === "root" && value === "true") root = true;
      continue;
    }
    applySetting(current.settings, key, value);
  }
  return { root, sections };
}

function parentDirectory(directory: string): string | undefined {
  if (directory === ".") return undefined;
  const parent = posix.dirname(directory);
  return parent === "" ? "." : parent;
}

function scopedPattern(directory: string, pattern: string): string {
  const relative = pattern.includes("/") ? pattern : `**/${pattern}`;
  return directory === "." ? relative : posix.join(directory, relative);
}

export interface EditorConfigImport {
  readonly settings: Partial<FormattingSettings>;
  readonly overrides: readonly ImportedFormattingOverride[];
}

/** Reads applicable EditorConfig files as data and preserves scoped sections. */
export async function editorConfigImport(
  registry: SnapshotRegistry,
  projectRoot: string,
): Promise<EditorConfigImport> {
  const parsed: { directory: string; config: ParsedEditorConfig }[] = [];
  let current: string | undefined = projectRoot === "" ? "." : projectRoot;
  while (current !== undefined) {
    const path =
      current === "." ? ".editorconfig" : posix.join(current, ".editorconfig");
    if (registry.resolve(path)?.targetKind === "file") {
      try {
        const contents = await readContainedFile(registry, path, {
          maxBytes: EDITORCONFIG_MAX_BYTES,
        });
        const config = parseEditorConfig(contents);
        parsed.push({ directory: current, config });
        if (config.root) break;
      } catch {
        // An unreadable EditorConfig contributes no copied values.
      }
    }
    current = parentDirectory(current);
  }

  const settings: Partial<FormattingSettings> = {};
  const overrides: ImportedFormattingOverride[] = [];
  for (const { directory, config } of [...parsed].reverse()) {
    for (const section of config.sections) {
      if (Object.keys(section.settings).length === 0) continue;
      if (section.pattern === "*" || section.pattern === "*.*") {
        Object.assign(settings, section.settings);
      } else {
        overrides.push(
          Object.freeze({
            files: Object.freeze([scopedPattern(directory, section.pattern)]),
            excludeFiles: Object.freeze([]),
            settings: Object.freeze({ ...section.settings }),
          }),
        );
      }
    }
  }
  return Object.freeze({
    settings: Object.freeze(settings),
    overrides: Object.freeze(overrides),
  });
}

export async function editorConfigSettings(
  registry: SnapshotRegistry,
  projectRoot: string,
): Promise<Partial<FormattingSettings>> {
  return (await editorConfigImport(registry, projectRoot)).settings;
}
