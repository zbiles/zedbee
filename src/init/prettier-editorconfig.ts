import { posix } from "node:path";
import type { ImportedFormattingOverride } from "../checks/prettier/project-types.js";
import type { FormattingSettings } from "../checks/prettier/settings.js";
import { readContainedFile } from "../inspection/read-json.js";
import type { SnapshotRegistry } from "../inspection/snapshot-registry.js";

const EDITORCONFIG_MAX_BYTES = 256 * 1024;

import {
  parseEditorConfig,
  editorConfigOptions,
  type EditorProperties,
} from "../checks/prettier/editorconfig.js";
import { DEFAULT_FORMATTING_SETTINGS } from "../checks/prettier/settings.js";
type ParsedEditorConfig = ReturnType<typeof parseEditorConfig>;

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
  readonly limitations: readonly string[];
}

/** Reads applicable EditorConfig files as data and preserves scoped sections. */
export async function editorConfigImport(
  registry: SnapshotRegistry,
  projectRoot: string,
): Promise<EditorConfigImport> {
  const limitations: string[] = [];
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
        limitations.push(
          `${path} could not be read; its EditorConfig values were not copied.`,
        );
      }
    }
    current = parentDirectory(current);
  }

  const settings: Partial<FormattingSettings> = {};
  const overrides: ImportedFormattingOverride[] = [];
  const universal: EditorProperties = {};
  const scopedProperties = new Map<string, EditorProperties>();
  let scoped = false;
  const scope = projectRoot === "." ? "**/*" : `${projectRoot}/**`;
  for (const { directory, config } of [...parsed].reverse()) {
    for (const section of config.sections) {
      const all = section.pattern === "*";
      const sectionKey = `${directory}\0${section.pattern}`;
      const previousScoped = scopedProperties.get(sectionKey) ?? {};
      const properties = {
        ...universal,
        ...previousScoped,
        ...section.properties,
      };
      const converted = editorConfigOptions(properties);
      const changed = new Set(Object.keys(section.properties));
      if (
        !["indent_size", "indent_style", "tab_width"].some((key) =>
          changed.has(key),
        )
      ) {
        delete converted.tabWidth;
        delete converted.useTabs;
      }
      if (!changed.has("max_line_length")) delete converted.printWidth;
      if (!changed.has("end_of_line")) delete converted.endOfLine;
      if (!changed.has("quote_type")) delete converted.singleQuote;
      if (!Number.isFinite(converted.printWidth ?? 80)) {
        limitations.push(
          "EditorConfig max_line_length=off cannot be copied as a finite managed printWidth.",
        );
        delete converted.printWidth;
      }
      // An unset must clear a previously imported value, not inherit it.
      const unsetKeys: Record<string, keyof FormattingSettings> = {
        indent_size: "tabWidth",
        tab_width: "tabWidth",
        indent_style: "useTabs",
        max_line_length: "printWidth",
        end_of_line: "endOfLine",
        quote_type: "singleQuote",
      };
      for (const [key, value] of Object.entries(section.properties)) {
        if (value === "unset" && unsetKeys[key]) {
          const setting = unsetKeys[key]!;
          Object.assign(converted, {
            [setting]: DEFAULT_FORMATTING_SETTINGS[setting],
          });
        }
      }
      if (Object.keys(converted).length === 0) continue;
      if (all) Object.assign(universal, section.properties);
      if (all && !scoped) Object.assign(settings, converted);
      else {
        scoped = true;
        if (!all) {
          scopedProperties.set(sectionKey, {
            ...previousScoped,
            ...section.properties,
          });
        }
        const original = scopedPattern(
          directory,
          section.pattern.replace(/^\//u, ""),
        );
        let pattern = original;
        if (projectRoot !== "." && !original.startsWith(`${projectRoot}/`)) {
          // Basename patterns have an exact scope-relative representation.
          if (!section.pattern.includes("/"))
            pattern = `${projectRoot}/**/${section.pattern}`;
          else {
            limitations.push(
              `EditorConfig pattern ${section.pattern} from ${directory} cannot be copied into ${projectRoot} exactly.`,
            );
            continue;
          }
        }
        overrides.push(
          Object.freeze({
            files: Object.freeze([all ? scope : pattern]),
            excludeFiles: Object.freeze([]),
            settings: Object.freeze(converted),
          }),
        );
      }
    }
  }
  return Object.freeze({
    settings: Object.freeze(settings),
    overrides: Object.freeze(overrides),
    limitations: Object.freeze(limitations),
  });
}

export async function editorConfigSettings(
  registry: SnapshotRegistry,
  projectRoot: string,
): Promise<Partial<FormattingSettings>> {
  return (await editorConfigImport(registry, projectRoot)).settings;
}
