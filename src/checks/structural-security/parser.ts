import { Lang, parse, type SgNode, type SgRoot } from "@ast-grep/napi";
import * as ts from "typescript";
import { safeExpectedToken } from "./parse-failures.js";

interface ParsePosition {
  readonly line: number;
  readonly column: number;
  readonly typescriptCode?: number;
  readonly expectedToken?: string;
}

export class StructuralParseError extends Error {
  constructor(readonly position: ParsePosition) {
    super("Structural security analysis failed.");
  }
}

export function structuralNodes(root: SgRoot): readonly SgNode[] {
  const found: SgNode[] = [];
  const visit = (node: SgNode): void => {
    found.push(node);
    for (const child of node.children()) visit(child);
  };
  visit(root.root());
  return found;
}

function errorIndex(nodes: readonly SgNode[]): number | undefined {
  const error = nodes.find((node, index) => {
    if (node.kind() === "ERROR") return true;
    if (index === 0) return false;
    const { start, end } = node.range();
    return start.index === end.index;
  });
  return error?.range().start.index;
}

function compatibleSource(parsed: ts.SourceFile, source: string): string {
  const parts: string[] = [];
  let offset = 0;
  const replace = (start: number, end: number, replacement: string): void => {
    parts.push(source.slice(offset, start), replacement);
    offset = end;
  };
  const supportsImportTypes = /\.(?:ts|tsx|mts|cts)$/iu.test(parsed.fileName);
  const visit = (node: ts.Node): void => {
    if (supportsImportTypes && ts.isImportTypeNode(node)) {
      const start = node.getStart(parsed);
      const end = node.getEnd();
      // This type-only expression has no runtime code to inspect.
      replace(
        start,
        end,
        `any${source.slice(start + 3, end).replace(/[^\r\n\u2028\u2029]/g, " ")}`,
      );
      return;
    }
    if (ts.isJsxText(node)) {
      const text = source.slice(node.pos, node.end);
      if (text.includes("&"))
        replace(node.pos, node.end, text.replace(/&/gu, " "));
      return;
    }
    if (
      ts.isIdentifier(node) &&
      node.escapedText === "using" &&
      node.getText(parsed) === "using"
    ) {
      // A resource declaration keyword is not an Identifier in the TS tree.
      // The spelling is only for parsing. Rules read the original source.
      replace(node.getStart(parsed), node.end, "z____");
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  parts.push(source.slice(offset));
  return parts.join("");
}

export function parseStructuralSource(
  language: Lang,
  file: string,
  source: string,
): { nodes: readonly SgNode[]; normalized: boolean } {
  const nodes = structuralNodes(parse(language, source));
  const error = errorIndex(nodes);
  if (error === undefined) return { nodes, normalized: false };

  const parsed = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    false,
    language === Lang.Tsx ? ts.ScriptKind.TSX : undefined,
  );
  // Read parser diagnostics without emitting, including for declaration files.
  const { parseDiagnostics: diagnostics } = parsed as ts.SourceFile & {
    readonly parseDiagnostics: readonly ts.DiagnosticWithLocation[];
  };
  const syntaxError = diagnostics.find(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  );
  const position = parsed.getLineAndCharacterOfPosition(
    syntaxError?.start ?? error,
  );
  if (syntaxError === undefined) {
    const compatible = compatibleSource(parsed, source);
    if (compatible !== source) {
      const retried = structuralNodes(parse(language, compatible));
      if (errorIndex(retried) === undefined)
        return { nodes: retried, normalized: true };
    }
  }
  const expectedToken =
    syntaxError?.code === 1005 && typeof syntaxError.messageText === "string"
      ? safeExpectedToken(
          /^'([^']+)' expected\.$/u.exec(syntaxError.messageText)?.[1],
        )
      : undefined;
  throw new StructuralParseError({
    line: position.line + 1,
    column: position.character + 1,
    ...(expectedToken === undefined ? {} : { expectedToken }),
    ...(syntaxError === undefined ? {} : { typescriptCode: syntaxError.code }),
  });
}
