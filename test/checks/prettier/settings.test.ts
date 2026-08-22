import { describe, expect, it } from "vitest";
import {
  DEFAULT_FORMATTING_SETTINGS,
  FORMATTING_SETTINGS_DEFINITION,
  formattingSettingsSchema,
  prettierOptions,
} from "../../../src/checks/prettier/settings.js";

const configuredSettings = {
  printWidth: 100,
  tabWidth: 4,
  useTabs: true,
  semi: false,
  singleQuote: true,
  quoteProps: "consistent",
  jsxSingleQuote: true,
  trailingComma: "es5",
  bracketSpacing: false,
  bracketSameLine: true,
  arrowParens: "avoid",
  proseWrap: "always",
  endOfLine: "crlf",
  singleAttributePerLine: true,
} as const;

describe("managed Prettier settings", () => {
  it("validates and maps the approved single-attribute-per-line option", () => {
    const settings = formattingSettingsSchema.parse(configuredSettings);

    expect(prettierOptions(settings)).toEqual(configuredSettings);
    expect(
      (DEFAULT_FORMATTING_SETTINGS as Readonly<Record<string, unknown>>)
        .singleAttributePerLine,
    ).toBe(false);
    expect(
      (
        FORMATTING_SETTINGS_DEFINITION.describe as Readonly<
          Record<string, unknown>
        >
      ).singleAttributePerLine,
    ).toMatch(/attribute/u);
  });

  it("rejects the unreleased mistaken embedded-language option", () => {
    expect(
      formattingSettingsSchema.safeParse({
        ...configuredSettings,
        embeddedLanguageFormatting: "off",
      }).success,
    ).toBe(false);
  });
});
