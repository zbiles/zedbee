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

function sanitizeMessage(
  message: string,
  snapshotRoot: string,
  repositoryRoot: string,
): string {
  return message
    .split(snapshotRoot)
    .join("<snapshot>")
    .split(repositoryRoot)
    .join("<repository>")
    .replaceAll("\\", "/")
    .replace(/(^|[\s("'`])(?:[A-Za-z]:\/|\/)[^\s'"`<>]+/gu, "$1<path>");
}

export function convertTypescriptDiagnostic(
  diagnostic: ts.Diagnostic,
  snapshotRoot: string,
  repositoryRoot: string,
): Observation | undefined {
  const rule = `typescript/TS${diagnostic.code}`;
  const flattened = ts.flattenDiagnosticMessageText(
    diagnostic.messageText,
    " ",
  );
  const sanitized = sanitizeMessage(flattened, snapshotRoot, repositoryRoot);
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
      ? `repository:${createHash("sha256").update(sanitized).digest("hex").slice(0, 16)}`
      : `${location.file}:${location.startLine ?? 0}:${location.startColumn ?? 0}`;
  return {
    check: "types",
    rule,
    identity: `${rule}:${scope}`,
    severity: severity(diagnostic.category),
    message: sanitized,
    ...(location === undefined ? {} : { location }),
  };
}
