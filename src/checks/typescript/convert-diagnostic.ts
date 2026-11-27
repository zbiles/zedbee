import { typescriptDiagnosticMessage } from "./diagnostic-message.js";
export { typescriptDiagnosticMessage } from "./diagnostic-message.js";
import { recordDiagnosticDetail } from "../diagnostic-details.js";
import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";
import * as ts from "typescript";
import type { Observation, Severity, SourceLocation } from "../../core/types.js";
import { normalizeRepositoryPath } from "../../inspection/read-json.js";

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
  return normalizeRepositoryPath(fromRoot);
}

function severity(category: ts.DiagnosticCategory): Severity {
  if (category === ts.DiagnosticCategory.Error) return "error";
  if (category === ts.DiagnosticCategory.Warning) return "warning";
  return "info";
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

function diagnosticLocation(
  diagnostic: ts.Diagnostic,
  path: string | undefined,
): SourceLocation | undefined {
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
  return location;
}

export function convertTypescriptDiagnostic(
  diagnostic: ts.Diagnostic,
  snapshotRoot: string,
  repositoryRoot: string,
): Observation | undefined {
  const rule = `typescript/TS${diagnostic.code}`;
  const sanitized = typescriptDiagnosticMessage(diagnostic.code);
  const flattened = ts.flattenDiagnosticMessageText(diagnostic.messageText, " ");
  const messageIdentity = privateMessageIdentity(
    flattened,
    snapshotRoot,
    repositoryRoot,
  );
  const path =
    diagnostic.file === undefined
      ? undefined
      : repositoryPath(snapshotRoot, diagnostic.file.fileName);
  if (diagnostic.file !== undefined && path === undefined) return undefined;
  const location = diagnosticLocation(diagnostic, path);
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
    flattened,
    snapshotRoot,
    diagnostic.file?.text,
  );
  return observation;
}
