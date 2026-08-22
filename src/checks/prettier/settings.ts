import { z } from "zod";
import type { ManagedSettingsDefinition } from "../../config/settings-definition.js";

export const formattingSettingsSchema = z
  .object({
    printWidth: z.number().int().positive(),
    tabWidth: z.number().int().positive(),
    useTabs: z.boolean(),
    semi: z.boolean(),
    singleQuote: z.boolean(),
    quoteProps: z.enum(["as-needed", "consistent", "preserve"]),
    jsxSingleQuote: z.boolean(),
    trailingComma: z.enum(["all", "es5", "none"]),
    bracketSpacing: z.boolean(),
    bracketSameLine: z.boolean(),
    arrowParens: z.enum(["always", "avoid"]),
    proseWrap: z.enum(["always", "never", "preserve"]),
    endOfLine: z.enum(["lf", "crlf", "cr", "auto"]),
    embeddedLanguageFormatting: z.enum(["auto", "off"]),
  })
  .strict();

export type FormattingSettings = z.infer<typeof formattingSettingsSchema>;

export const DEFAULT_FORMATTING_SETTINGS: Readonly<FormattingSettings> =
  Object.freeze({
    printWidth: 80,
    tabWidth: 2,
    useTabs: false,
    semi: true,
    singleQuote: false,
    quoteProps: "as-needed",
    jsxSingleQuote: false,
    trailingComma: "all",
    bracketSpacing: true,
    bracketSameLine: false,
    arrowParens: "always",
    proseWrap: "preserve",
    endOfLine: "lf",
    embeddedLanguageFormatting: "auto",
  });

export function prettierOptions(
  settings: Readonly<FormattingSettings>,
): FormattingSettings {
  return {
    printWidth: settings.printWidth,
    tabWidth: settings.tabWidth,
    useTabs: settings.useTabs,
    semi: settings.semi,
    singleQuote: settings.singleQuote,
    quoteProps: settings.quoteProps,
    jsxSingleQuote: settings.jsxSingleQuote,
    trailingComma: settings.trailingComma,
    bracketSpacing: settings.bracketSpacing,
    bracketSameLine: settings.bracketSameLine,
    arrowParens: settings.arrowParens,
    proseWrap: settings.proseWrap,
    endOfLine: settings.endOfLine,
    embeddedLanguageFormatting: settings.embeddedLanguageFormatting,
  };
}

export const FORMATTING_SETTINGS_DEFINITION: ManagedSettingsDefinition<FormattingSettings> =
  Object.freeze({
    scope: "file",
    schema: formattingSettingsSchema,
    defaults: DEFAULT_FORMATTING_SETTINGS,
    describe: Object.freeze({
      printWidth: "Maximum formatted line width.",
      tabWidth: "Number of spaces per indentation level.",
      useTabs: "Indent lines with tabs instead of spaces.",
      semi: "Print semicolons at statement endings.",
      singleQuote: "Use single quotes instead of double quotes.",
      quoteProps: "How object property names are quoted.",
      jsxSingleQuote: "Use single quotes in JSX attributes.",
      trailingComma: "Print trailing commas where valid.",
      bracketSpacing: "Print spaces between object literal braces.",
      bracketSameLine:
        "Keep a multi-line element bracket on the last prop line.",
      arrowParens:
        "Include parentheses around a sole arrow function parameter.",
      proseWrap: "How Markdown prose is wrapped.",
      endOfLine: "Line ending written by the formatter.",
      embeddedLanguageFormatting: "Format embedded code when possible.",
    }),
    toEngineOptions: prettierOptions,
  });
