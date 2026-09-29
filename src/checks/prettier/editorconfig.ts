import type { FormattingSettings } from "./settings.js";

export type EditorProperties = Record<string, string>;
export interface EditorSection {
  readonly pattern: string;
  readonly properties: EditorProperties;
}

/** Data only: retain properties until matching sections have been merged. */
export function parseEditorConfig(contents: string): {
  root: boolean;
  sections: EditorSection[];
} {
  let root = false;
  let current: EditorSection | undefined;
  const sections: EditorSection[] = [];
  const sectionsByPattern = new Map<string, EditorSection>();
  for (const raw of contents.split(/\r\n|\n|\r/u)) {
    const line = raw.trim();
    if (!line || /^[#;]/u.test(line)) continue;
    if (line.startsWith("[") && line.endsWith("]")) {
      const pattern = line.slice(1, -1);
      current = sectionsByPattern.get(pattern);
      if (current === undefined) {
        current = { pattern, properties: {} };
        sectionsByPattern.set(pattern, current);
        sections.push(current);
      }
      continue;
    }
    const index = line.indexOf("=");
    if (index <= 0) continue;
    const key = line.slice(0, index).trim().toLowerCase();
    const value = line
      .slice(index + 1)
      .trim()
      .toLowerCase();
    if (current) current.properties[key] = value;
    else if (key === "root") root = value === "true";
  }
  return { root, sections };
}

/** EditorConfig's dependent indentation properties are normalized after merge. */
export function editorConfigOptions(
  properties: EditorProperties,
): Partial<FormattingSettings> {
  const values = { ...properties };
  if (values.indent_style === "tab" && values.indent_size === undefined)
    values.indent_size = "tab";
  if (
    values.indent_size !== undefined &&
    values.tab_width === undefined &&
    values.indent_size !== "tab"
  )
    values.tab_width = values.indent_size;
  if (values.indent_size === "tab" && values.tab_width !== undefined)
    values.indent_size = values.tab_width;
  const positive = (value: string | undefined): number | undefined => {
    const number = Number(value);
    return Number.isSafeInteger(number) && number > 0 ? number : undefined;
  };
  const result: Partial<FormattingSettings> = {};
  if (values.indent_style === "space") result.useTabs = false;
  else if (values.indent_style === "tab" || values.indent_size === "tab")
    result.useTabs = true;
  const width =
    result.useTabs === false
      ? (positive(values.indent_size) ?? positive(values.tab_width))
      : positive(values.tab_width);
  if (width !== undefined) result.tabWidth = width;
  const printWidth = positive(values.max_line_length);
  if (printWidth !== undefined) result.printWidth = printWidth;
  // Native Prettier represents 'off' with Infinity; copy reports it as nonfinite.
  if (values.max_line_length === "off") result.printWidth = Infinity;
  if (values.quote_type === "single") result.singleQuote = true;
  else if (values.quote_type === "double") result.singleQuote = false;
  if (["lf", "crlf", "cr"].includes(values.end_of_line ?? ""))
    result.endOfLine = values.end_of_line as "lf" | "crlf" | "cr";
  return result;
}
