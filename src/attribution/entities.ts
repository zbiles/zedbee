import { extname } from "node:path";
import * as ts from "typescript";
import type { ChangedEntity } from "../core/types.js";
import type { LineRange } from "../git/change-set.js";
import { normalizeRepositoryRelativePath } from "./fingerprint.js";

const SUPPORTED_EXTENSIONS = new Set([
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
]);

interface EntityDeclaration {
  readonly kind: ChangedEntity["kind"];
  readonly name: string;
  readonly node: ts.Node;
  readonly identityQualifiers?: readonly LexicalOwner[];
}

interface LexicalOwner {
  readonly kind: string;
  readonly name: string;
}

export interface MetricEntitySpan {
  readonly entity: ChangedEntity;
  readonly startOffset: number;
  readonly endOffset: number;
}

function canonicalName(name: string): string {
  if (
    name.length === 0 ||
    name.trim() !== name ||
    /[\u0000-\u001f\u007f]/u.test(name)
  ) {
    throw new TypeError("Expected a canonical syntax entity name");
  }
  return name;
}

function declarationName(
  name: ts.PropertyName | ts.BindingName | undefined,
): string | undefined {
  if (name === undefined) return undefined;
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name))
    return canonicalName(name.text);
  if (ts.isStringLiteral(name) || ts.isNumericLiteral(name))
    return canonicalName(name.text);
  return undefined;
}

function memberName(name: ts.PropertyName): string | undefined {
  const declared = declarationName(name);
  if (declared !== undefined) return declared;
  if (!ts.isComputedPropertyName(name)) return undefined;
  const expression = name.expression;
  if (
    !ts.isPropertyAccessExpression(expression) ||
    !ts.isIdentifier(expression.expression) ||
    expression.expression.text !== "Symbol"
  ) {
    return undefined;
  }
  return canonicalName(`Symbol.${expression.name.text}`);
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node)?.some((modifier) => modifier.kind === kind) ?? false)
  );
}

function hasDefaultModifier(node: ts.Node): boolean {
  return hasModifier(node, ts.SyntaxKind.DefaultKeyword);
}

function hasStaticModifier(node: ts.Node): boolean {
  return hasModifier(node, ts.SyntaxKind.StaticKeyword);
}

function memberDeclaration(
  node:
    | ts.MethodDeclaration
    | ts.GetAccessorDeclaration
    | ts.SetAccessorDeclaration,
  role: "method" | "get" | "set",
  syntaxPath: readonly number[],
): EntityDeclaration | undefined {
  if (node.body === undefined) return undefined;
  const name = memberName(node.name);
  return name === undefined
    ? undefined
    : {
        kind: "method",
        name,
        node,
        identityQualifiers: [
          ...(ts.isObjectLiteralExpression(node.parent)
            ? [
                {
                  kind: "object-scope",
                  name: `object@${syntaxPath.slice(0, -1).join(".")}`,
                },
              ]
            : []),
          {
            kind: "member-scope",
            name: hasStaticModifier(node) ? "static" : "instance",
          },
          { kind: "member-role", name: role },
        ],
      };
}

function constructorDeclaration(
  node: ts.ConstructorDeclaration,
): EntityDeclaration | undefined {
  if (node.body === undefined) return undefined;
  return {
    kind: "method",
    name: "constructor",
    node,
    identityQualifiers: [
      { kind: "member-scope", name: "instance" },
      { kind: "member-role", name: "constructor" },
    ],
  };
}

function propertyCodeUnitDeclaration(
  node: ts.PropertyDeclaration | ts.PropertyAssignment,
  syntaxPath: readonly number[],
): EntityDeclaration | undefined {
  if (
    node.initializer === undefined ||
    (ts.isPropertyAssignment(node) &&
      !ts.isArrowFunction(node.initializer) &&
      !ts.isFunctionExpression(node.initializer))
  ) {
    return undefined;
  }
  const name = memberName(node.name);
  return name === undefined
    ? undefined
    : {
        kind: "function",
        name,
        node,
        identityQualifiers: [
          ...(ts.isPropertyAssignment(node)
            ? [
                {
                  kind: "object-scope",
                  name: `object@${syntaxPath.slice(0, -1).join(".")}`,
                },
                { kind: "member-role", name: "property" },
              ]
            : [
                { kind: "field-scope", name: `field@${syntaxPath.join(".")}` },
                {
                  kind: "member-scope",
                  name: hasStaticModifier(node) ? "static" : "instance",
                },
                { kind: "member-role", name: "field" },
              ]),
        ],
      };
}

function isClaimedFunctionExpression(node: ts.Node): boolean {
  const parent = node.parent;
  return (
    (ts.isVariableDeclaration(parent) && parent.initializer === node) ||
    (ts.isPropertyDeclaration(parent) && parent.initializer === node) ||
    (ts.isPropertyAssignment(parent) && parent.initializer === node) ||
    (ts.isExportAssignment(parent) && parent.expression === node)
  );
}

function structuralFunctionDeclaration(
  node: ts.ArrowFunction | ts.FunctionExpression,
  syntaxPath: readonly number[],
): EntityDeclaration | undefined {
  if (isClaimedFunctionExpression(node)) return undefined;
  const declared = ts.isFunctionExpression(node)
    ? declarationName(node.name)
    : undefined;
  const name = canonicalName(
    `${declared ?? "anonymous"}@${syntaxPath.join(".")}`,
  );
  return { kind: "function", name, node };
}

function entityDeclaration(
  node: ts.Node,
  syntaxPath: readonly number[],
): EntityDeclaration | undefined {
  if (ts.isFunctionDeclaration(node)) {
    if (node.body === undefined) return undefined;
    const name =
      declarationName(node.name) ??
      (hasDefaultModifier(node) ? "default" : undefined);
    return name === undefined ? undefined : { kind: "function", name, node };
  }
  if (ts.isClassDeclaration(node)) {
    const name =
      declarationName(node.name) ??
      (hasDefaultModifier(node) ? "default" : undefined);
    return name === undefined ? undefined : { kind: "class", name, node };
  }
  if (ts.isMethodDeclaration(node))
    return memberDeclaration(node, "method", syntaxPath);
  if (ts.isGetAccessorDeclaration(node))
    return memberDeclaration(node, "get", syntaxPath);
  if (ts.isSetAccessorDeclaration(node))
    return memberDeclaration(node, "set", syntaxPath);
  if (ts.isConstructorDeclaration(node)) return constructorDeclaration(node);
  if (ts.isPropertyDeclaration(node))
    return propertyCodeUnitDeclaration(node, syntaxPath);
  if (ts.isPropertyAssignment(node))
    return propertyCodeUnitDeclaration(node, syntaxPath);
  if (
    ts.isVariableDeclaration(node) &&
    node.initializer !== undefined &&
    (ts.isArrowFunction(node.initializer) ||
      ts.isFunctionExpression(node.initializer))
  ) {
    const name = declarationName(node.name);
    return name === undefined ? undefined : { kind: "function", name, node };
  }
  if (
    ts.isExportAssignment(node) &&
    (ts.isArrowFunction(node.expression) ||
      ts.isFunctionExpression(node.expression))
  ) {
    return { kind: "function", name: "default", node };
  }
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    return structuralFunctionDeclaration(node, syntaxPath);
  }
  return undefined;
}

function structuralOwner(node: ts.Node): LexicalOwner | undefined {
  if (ts.isVariableDeclaration(node)) {
    const name = declarationName(node.name);
    return name === undefined ? undefined : { kind: "variable", name };
  }
  return undefined;
}

function entityIdentity(
  declaration: EntityDeclaration,
  file: string,
  owners: readonly LexicalOwner[],
): string {
  if (owners.length === 0 && declaration.identityQualifiers === undefined) {
    return `${declaration.kind}:${file}:${declaration.name}`;
  }
  const qualified = [
    ...owners,
    ...(declaration.identityQualifiers ?? []),
    declaration,
  ]
    .map(({ kind, name }) => `${kind}=${encodeURIComponent(name)}`)
    .join("/");
  return `${declaration.kind}:${file}:${qualified}`;
}

function normalizedRanges(
  ranges: readonly LineRange[],
  lineCount: number,
): readonly LineRange[] {
  if (!Array.isArray(ranges))
    throw new TypeError("Expected line ranges to be an array");
  const snapshots = ranges.map((candidate) => {
    if (typeof candidate !== "object" || candidate === null) {
      throw new TypeError("Expected each line range to be an object");
    }
    const input = candidate as Record<string, unknown>;
    const start = input.start;
    const end = input.end;
    if (
      typeof start !== "number" ||
      typeof end !== "number" ||
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 1 ||
      end < start ||
      end > lineCount
    ) {
      throw new TypeError(
        "Expected a valid staged line range within the source file",
      );
    }
    return Object.freeze({ start, end });
  });
  return Object.freeze(snapshots);
}

function intersects(
  startLine: number,
  endLine: number,
  ranges: readonly LineRange[],
): boolean {
  return ranges.some(
    (range) => startLine <= range.end && endLine >= range.start,
  );
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function collectChangedEntities(
  sourceText: string,
  file: string,
  ranges: readonly LineRange[],
): readonly ChangedEntity[] {
  if (typeof sourceText !== "string")
    throw new TypeError("Expected source text to be a string");
  const normalizedFile = normalizeRepositoryRelativePath(file);
  const extension = extname(normalizedFile);
  if (!SUPPORTED_EXTENSIONS.has(extension)) {
    throw new TypeError("Expected a JavaScript or TypeScript source path");
  }

  const diagnostics = ts.transpileModule(sourceText, {
    fileName: normalizedFile,
    reportDiagnostics: true,
    compilerOptions: {
      allowJs: true,
      jsx: ts.JsxEmit.Preserve,
      target: ts.ScriptTarget.Latest,
    },
  });
  if (
    diagnostics.diagnostics?.some(
      ({ category }) => category === ts.DiagnosticCategory.Error,
    )
  ) {
    throw new SyntaxError(
      `Unable to parse staged source file: ${normalizedFile}`,
    );
  }

  const parsedSourceFile = ts.createSourceFile(
    normalizedFile,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
  );
  const entities: ChangedEntity[] = [];
  const lineCount = parsedSourceFile.getLineStarts().length;
  const snapshots = normalizedRanges(ranges, lineCount);

  function visit(
    node: ts.Node,
    owners: readonly LexicalOwner[],
    syntaxPath: readonly number[],
  ): void {
    const declaration = entityDeclaration(node, syntaxPath);
    if (declaration !== undefined) {
      const startLine =
        parsedSourceFile.getLineAndCharacterOfPosition(
          declaration.node.getStart(parsedSourceFile),
        ).line + 1;
      const endLine =
        parsedSourceFile.getLineAndCharacterOfPosition(
          declaration.node.getEnd(),
        ).line + 1;
      if (intersects(startLine, endLine, snapshots)) {
        const identity = entityIdentity(declaration, normalizedFile, owners);
        entities.push(
          Object.freeze({
            kind: declaration.kind,
            name: declaration.name,
            file: normalizedFile,
            startLine,
            endLine,
            identity,
          }),
        );
      }
    }
    const owner = declaration ?? structuralOwner(node);
    const childOwners =
      owner === undefined
        ? owners
        : [
            ...owners,
            ...(declaration?.identityQualifiers ?? []),
            { kind: owner.kind, name: owner.name },
          ];
    let childIndex = 0;
    node.forEachChild((child) => {
      visit(child, childOwners, [...syntaxPath, childIndex]);
      childIndex += 1;
    });
  }
  visit(parsedSourceFile, [], []);

  entities.sort(
    (left, right) =>
      compareCodeUnits(left.file, right.file) ||
      left.startLine - right.startLine ||
      left.endLine - right.endLine ||
      compareCodeUnits(left.kind, right.kind) ||
      compareCodeUnits(left.name, right.name) ||
      compareCodeUnits(left.identity, right.identity),
  );
  return Object.freeze(entities);
}

/** Canonical syntax entities with offsets for inspector-owned metric adapters. */
export function collectMetricEntitySpans(
  sourceText: string,
  file: string,
): readonly MetricEntitySpan[] {
  const normalizedFile = normalizeRepositoryRelativePath(file);
  const parsed = ts.createSourceFile(
    normalizedFile,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
  );
  const lineCount = parsed.getLineStarts().length;
  // Reuse the public collector's extension, syntax, and canonical-path checks.
  collectChangedEntities(sourceText, normalizedFile, [
    { start: 1, end: lineCount },
  ]);
  const spans: MetricEntitySpan[] = [];

  function visit(
    node: ts.Node,
    owners: readonly LexicalOwner[],
    syntaxPath: readonly number[],
  ): void {
    const declaration = entityDeclaration(node, syntaxPath);
    if (declaration !== undefined && declaration.kind !== "class") {
      const startOffset = declaration.node.getStart(parsed);
      const endOffset = declaration.node.getEnd();
      const startLine =
        parsed.getLineAndCharacterOfPosition(startOffset).line + 1;
      const endLine = parsed.getLineAndCharacterOfPosition(endOffset).line + 1;
      spans.push(
        Object.freeze({
          entity: Object.freeze({
            kind: declaration.kind,
            name: declaration.name,
            file: normalizedFile,
            startLine,
            endLine,
            identity: entityIdentity(declaration, normalizedFile, owners),
          }),
          startOffset,
          endOffset,
        }),
      );
    }
    const owner = declaration ?? structuralOwner(node);
    const childOwners =
      owner === undefined
        ? owners
        : [
            ...owners,
            ...(declaration?.identityQualifiers ?? []),
            { kind: owner.kind, name: owner.name },
          ];
    let childIndex = 0;
    node.forEachChild((child) => {
      visit(child, childOwners, [...syntaxPath, childIndex]);
      childIndex += 1;
    });
  }
  visit(parsed, [], []);
  return Object.freeze(spans);
}
