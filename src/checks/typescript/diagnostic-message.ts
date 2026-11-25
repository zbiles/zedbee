import { createRequire } from "node:module";
import type { DiagnosticMessage } from "typescript";

const require = createRequire(import.meta.url);

let messageTemplates: ReadonlyMap<number, string> | undefined;

/** Compiler-owned prose only: interpolated literals may need source context to detect. */
export function typescriptDiagnosticMessage(code: number): string {
  if (messageTemplates === undefined) {
    const { Diagnostics: diagnostics = {} } = require("typescript") as {
      Diagnostics?: Record<string, DiagnosticMessage>;
    };
    messageTemplates = new Map(
      Object.values(diagnostics)
        .filter(
          (entry) =>
            Number.isSafeInteger(entry.code) &&
            typeof entry.message === "string",
        )
        .map((entry) => [
          entry.code,
          entry.message.replace(/\{\d+\}/gu, "[source]"),
        ]),
    );
  }
  return messageTemplates.get(code) ?? "TypeScript reported a diagnostic.";
}
