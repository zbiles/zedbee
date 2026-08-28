import type {
  CheckConfigurationDescription,
  EffectiveSettingDescription,
} from "./description.js";

const TERMINAL_VALUE_PREVIEW_CODEPOINTS = 240;
const OVERRIDE_PATTERN_PREVIEW_COUNT = 3;
const OVERRIDE_PATTERN_PREVIEW_CODEPOINTS = 80;
const UNSAFE_TERMINAL_CHARACTER = /[\p{Cc}\p{Cf}\u2028\u2029]/gu;

function pluralizeValue(count: number): string {
  return count === 1 ? "value" : "values";
}

export function configurationSummary(
  configuration: CheckConfigurationDescription,
): string {
  const counts = { profile: 0, repository: 0 };
  for (const value of Object.values(configuration.values)) {
    counts[value.source] += 1;
  }
  const parts: string[] = [];
  if (counts.profile > 0) {
    parts.push(`${counts.profile} profile ${pluralizeValue(counts.profile)}`);
  }
  if (counts.repository > 0) {
    parts.push(
      `${counts.repository} repository ${pluralizeValue(counts.repository)}`,
    );
  }
  if (parts.length === 0) parts.push("profile defaults");
  return `Configuration: ${parts.join(", ")}`;
}

function unicodeEscape(character: string): string {
  const code = character.codePointAt(0) ?? 0;
  return code <= 0xffff
    ? `\\u${code.toString(16).padStart(4, "0")}`
    : `\\u{${code.toString(16)}}`;
}

function terminalSafeText(value: string): string {
  return value.replaceAll(UNSAFE_TERMINAL_CHARACTER, unicodeEscape);
}

function boundedPreview(
  value: string,
  maximumCodepoints: number,
): { readonly text: string; readonly truncated: boolean } {
  const codepoints = Array.from(value);
  if (codepoints.length <= maximumCodepoints) {
    return { text: value, truncated: false };
  }
  const text = codepoints
    .slice(0, maximumCodepoints)
    .join("")
    .replace(/\\u[0-9a-fA-F]{0,3}$/u, "")
    .replace(/\\u\{[0-9a-fA-F]*$/u, "")
    .replace(/\\$/u, "");
  return { text: `${text}... [truncated]`, truncated: true };
}

export function terminalValuePreview(value: unknown): string {
  const rendered = JSON.stringify(value);
  return boundedPreview(
    terminalSafeText(rendered === undefined ? "null" : rendered),
    TERMINAL_VALUE_PREVIEW_CODEPOINTS,
  ).text;
}

function overridePatternPreview(pattern: string): string {
  return boundedPreview(
    terminalSafeText(pattern),
    OVERRIDE_PATTERN_PREVIEW_CODEPOINTS,
  ).text;
}

export function configurationValueLine(
  key: string,
  value: EffectiveSettingDescription,
): string {
  return `${key}: ${terminalValuePreview(value.value)} (${value.source})${
    value.customized ? " (customized)" : ""
  }`;
}

export function effectiveSettingsLines(
  configuration: CheckConfigurationDescription,
  prefix: string,
): readonly string[] {
  return Object.entries(configuration.values)
    .filter(([key]) => key.startsWith(prefix))
    .map(([key, value]) =>
      configurationValueLine(key.slice(prefix.length), value),
    );
}

export function configurationOverrideLine(
  files: readonly string[],
  values: Readonly<Record<string, unknown>>,
): string {
  const omitted = Math.max(0, files.length - OVERRIDE_PATTERN_PREVIEW_COUNT);
  const renderedFiles = files
    .slice(0, OVERRIDE_PATTERN_PREVIEW_COUNT)
    .map(overridePatternPreview);
  const filesPreview =
    omitted === 0
      ? renderedFiles.join(", ")
      : `${renderedFiles.join(", ")}, ... [truncated] (+${omitted} patterns)`;
  const renderedValues = Object.entries(values)
    .map(([key, value]) => `${key}: ${terminalValuePreview(value)}`)
    .join(", ");
  return `Override ${filesPreview}: ${renderedValues}`;
}

export function configurationTextLines(
  configuration: CheckConfigurationDescription,
  effectiveSettingsPrefix?: string,
): readonly string[] {
  if (effectiveSettingsPrefix !== undefined) {
    const overrides = configuration.overrides.map(({ files, values }) =>
      configurationOverrideLine(files, values),
    );
    return [
      configurationSummary(configuration),
      "Effective settings:",
      ...effectiveSettingsLines(configuration, effectiveSettingsPrefix),
      ...overrides,
    ];
  }
  const customizedValues = Object.entries(configuration.values)
    .filter(([, value]) => value.customized)
    .map(([key, value]) => configurationValueLine(key, value));
  const overrides = configuration.overrides.map(({ files, values }) =>
    configurationOverrideLine(files, values),
  );
  return [
    configurationSummary(configuration),
    ...customizedValues,
    ...overrides,
  ];
}
