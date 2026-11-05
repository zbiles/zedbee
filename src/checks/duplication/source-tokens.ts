import ts from "typescript";
import {
  ContainedFileSizeError,
  readContainedFile,
} from "../../inspection/read-json.js";
import type { SnapshotRegistry } from "../../inspection/snapshot-registry.js";
import type { jscpdOptions } from "./settings.js";

export interface SourceToken {
  readonly kind: number;
  readonly text: string;
  readonly start: number;
  readonly end: number;
  readonly line: number;
}
export interface TokenizedSource {
  readonly file: string;
  readonly tokens: readonly SourceToken[];
  readonly text: string;
  readonly valid: boolean;
}
export type DuplicationSourceIndex = ReadonlyMap<string, TokenizedSource>;

export async function loadDuplicationSources(
  registry: SnapshotRegistry,
  files: readonly string[],
  _settings: ReturnType<typeof jscpdOptions>,
  signal: AbortSignal,
): Promise<DuplicationSourceIndex> {
  const paths = [...new Set(files)].sort();
  const result = new Map<string, TokenizedSource>();
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, paths.length) }, async () => {
      while (cursor < paths.length) {
        signal.throwIfAborted();
        const file = paths[cursor++]!;
        let text: string;
        try {
          text = await readContainedFile(registry, file, {
            maxBytes: 8 * 1024 * 1024,
          });
        } catch (error) {
          if (!(error instanceof ContainedFileSizeError)) throw error;
          result.set(file, { file, tokens: [], text: "", valid: false });
          continue;
        }
        signal.throwIfAborted();
        const kind = /\.tsx$/iu.test(file)
          ? ts.ScriptKind.TSX
          : /\.jsx$/iu.test(file)
            ? ts.ScriptKind.JSX
            : /\.(?:js|mjs|cjs)$/iu.test(file)
              ? ts.ScriptKind.JS
              : ts.ScriptKind.TS;
        const source = ts.createSourceFile(
          file,
          text,
          ts.ScriptTarget.Latest,
          true,
          kind,
        );
        const tokens: SourceToken[] = [];
        const visit = (node: ts.Node): void => {
          if (ts.isJSDoc(node)) return;
          const children = node.getChildren(source);
          if (children.length) {
            for (const child of children) visit(child);
            return;
          }
          if (
            node.kind === ts.SyntaxKind.EndOfFileToken ||
            node.kind === ts.SyntaxKind.SyntaxList
          )
            return;
          const start = node.getStart(source);
          const end = node.getEnd();
          if (end > start)
            tokens.push({
              kind: node.kind,
              text: text.slice(start, end),
              start,
              end,
              line: source.getLineAndCharacterOfPosition(start).line + 1,
            });
        };
        visit(source);
        const diagnostics = (
          source as ts.SourceFile & { parseDiagnostics: readonly unknown[] }
        ).parseDiagnostics;
        result.set(file, {
          file,
          tokens,
          text,
          valid: diagnostics.length === 0,
        });
      }
    }),
  );
  return result;
}
