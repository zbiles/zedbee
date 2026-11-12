import { recordDiagnosticDetail } from "../diagnostic-details.js";
import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";
import * as ts from "typescript";
import type { Observation, Severity } from "../../core/types.js";

function normalize(path: string): string {
  return path.split(sep).join("/");
}

function repositoryPath(
  snapshotRoot: string,
  fileName: string,
): string | undefined {
  const fromRoot = relative(snapshotRoot, resolve(fileName));
  if (
    fromRoot === "" ||
    isAbsolute(fromRoot) ||
    fromRoot === ".." ||
    fromRoot.startsWith(`..${sep}`)
  ) {
    return undefined;
  }
  return normalize(fromRoot);
}

function severity(category: ts.DiagnosticCategory): Severity {
  if (category === ts.DiagnosticCategory.Error) return "error";
  if (category === ts.DiagnosticCategory.Warning) return "warning";
  return "info";
}

let messageTemplates: ReadonlyMap<number, string> | undefined;

/** Compiler-owned prose only: interpolated literals may need source context to detect. */
export function typescriptDiagnosticMessage(code: number): string {
  if (messageTemplates === undefined) {
    const diagnostics =
      (ts as unknown as { Diagnostics?: Record<string, ts.DiagnosticMessage> })
        .Diagnostics ?? {};
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

function privateMessageIdentity(
  message: string,
  snapshotRoot: string,
  repositoryRoot: string,
): string {
  const normalized = message
    .split(snapshotRoot)
    .join("<snapshot>")
    .split(repositoryRoot)
    .join("<repository>")
    .replaceAll("\\", "/")
    .replace(/(^|[\s("'`])(?:[A-Za-z]:\/|\/)[^\s'"`<>]+/gu, "$1<path>");
  return createHash("sha256").update(normalized).digest("hex");
}

export function convertTypescriptDiagnostic(
  diagnostic: ts.Diagnostic,
  snapshotRoot: string,
  repositoryRoot: string,
): Observation | undefined {
  const rule = `typescript/TS${diagnostic.code}`;
  const sanitized = typescriptDiagnosticMessage(diagnostic.code);
  const messageIdentity = privateMessageIdentity(
    ts.flattenDiagnosticMessageText(diagnostic.messageText, " "),
    snapshotRoot,
    repositoryRoot,
  );
  const path =
    diagnostic.file === undefined
      ? undefined
      : repositoryPath(snapshotRoot, diagnostic.file.fileName);
  if (diagnostic.file !== undefined && path === undefined) return undefined;
  const position =
    diagnostic.file !== undefined && diagnostic.start !== undefined
      ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start)
      : undefined;
  const endPosition =
    diagnostic.file !== undefined &&
    diagnostic.start !== undefined &&
    diagnostic.length !== undefined
      ? diagnostic.file.getLineAndCharacterOfPosition(
          diagnostic.start + diagnostic.length,
        )
      : undefined;
  const location =
    path === undefined
      ? undefined
      : {
          file: path,
          ...(position === undefined
            ? {}
            : {
                startLine: position.line + 1,
                startColumn: position.character + 1,
              }),
          ...(endPosition === undefined
            ? {}
            : {
                endLine: endPosition.line + 1,
                endColumn: endPosition.character + 1,
              }),
        };
  const scope =
    location === undefined
      ? `repository:${messageIdentity.slice(0, 16)}`
      : `${location.file}:${location.startLine ?? 0}:${location.startColumn ?? 0}`;
  const observation: Observation = {
    check: "types",
    rule,
    identity: `${rule}:${scope}`,
    comparisonIdentity: messageIdentity,
    severity: severity(diagnostic.category),
    message: sanitized,
    ...(location === undefined ? {} : { location }),
  };
  recordDiagnosticDetail(
    observation,
    ts.flattenDiagnosticMessageText(diagnostic.messageText, " "),
    snapshotRoot,
    diagnostic.file?.text,
  );
  return observation;
}
