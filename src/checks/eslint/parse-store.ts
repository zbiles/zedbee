import { createRequire } from "node:module";
import type { Linter } from "eslint";
import tseslint from "typescript-eslint";
import type * as ts from "typescript";
import type * as TypescriptParser from "@typescript-eslint/parser";
import { analysisKey, analysisStore } from "../analysis-reuse.js";

const typescriptSyntax = Symbol("typescript-eslint untyped syntax");
const javascriptSyntax = Symbol("ESLint espree syntax");

/** Copy unbound syntax only, never Programs, scope classes or parser services.
 * TypeScript syntax objects use prototype methods with `this`, ordinary own
 * fields and parent links. Preserve those prototypes and graph relationships.
 */
function copySyntax<T extends object>(value: T): T | undefined {
  const seen = new Map<object, object>();
  const pending: [object, object][] = [];
  let slots = 0;
  function copy(item: unknown): unknown {
    if (item === null || typeof item !== "object") return item;
    const previous = seen.get(item);
    if (previous !== undefined) return previous;
    if (seen.size >= 50_000) throw new RangeError("Syntax retention limit");
    let result: object;
    if (item instanceof Map) result = new Map();
    else if (item instanceof RegExp)
      result = new RegExp(item.source, item.flags);
    else if (Array.isArray(item)) result = [];
    else if (Object.prototype.toString.call(item) === "[object Object]")
      result = Object.create(Object.getPrototypeOf(item));
    else throw new TypeError("Unsupported syntax state");
    seen.set(item, result);
    pending.push([item, result]);
    return result;
  }
  try {
    const result = copy(value) as T;
    for (let index = 0; index < pending.length; index += 1) {
      const [source, target] = pending[index]!;
      if (source instanceof Map && target instanceof Map) {
        for (const [key, item] of source) target.set(copy(key), copy(item));
      }
      for (const key of Reflect.ownKeys(source)) {
        if (++slots > 500_000 || typeof key === "symbol")
          throw new RangeError("Syntax retention limit");
        const descriptor = Object.getOwnPropertyDescriptor(source, key)!;
        if (!("value" in descriptor))
          throw new TypeError("Unsupported syntax accessor");
        // The unbound TS SourceFile carries this upstream syntax callback.
        // Other own functions or hidden state cannot enter the retained tree.
        if (
          typeof descriptor.value === "function" &&
          key !== "setExternalModuleIndicator"
        )
          throw new TypeError("Unsupported syntax method");
        descriptor.value = copy(descriptor.value);
        if (
          descriptor.configurable &&
          descriptor.enumerable &&
          descriptor.writable
        ) {
          (target as Record<string, unknown>)[key] = descriptor.value;
        } else {
          Object.defineProperty(target, key, descriptor);
        }
      }
    }
    return result;
  } catch {
    // Optional reuse limits never suppress the upstream parser or its errors.
    return undefined;
  }
}

const upstream = tseslint.parser as unknown as typeof TypescriptParser;
export const reuseTypescriptParser = {
  ...tseslint.parser,
  parseForESLint(
    code: string | ts.SourceFile,
    options?: TypescriptParser.ParserOptions | null,
  ): ReturnType<typeof TypescriptParser.parseForESLint> {
    const store = analysisStore<ts.SourceFile>(typescriptSyntax);
    // Typed services belong to their program and still get an independent
    // upstream conversion/scope analysis. Never cache their mutable result.
    if (
      store === undefined ||
      typeof code !== "string" ||
      options?.programs !== undefined ||
      options?.project ||
      options?.projectService
    ) {
      return upstream.parseForESLint(code, options);
    }
    const key = analysisKey([code, options]);
    if (key === undefined) return upstream.parseForESLint(code, options);
    const syntax = store.get(key);
    if (syntax !== undefined) {
      // This is the upstream parser's public string | SourceFile input API.
      // It creates fresh ESTree nodes, node maps and private-field scopes.
      const copy = copySyntax(syntax);
      if (copy !== undefined) return upstream.parseForESLint(copy, options);
    }
    const result = upstream.parseForESLint(code, options);
    const sourceFile = result.services.esTreeNodeToTSNodeMap.get(result.ast);
    if (result.services.program === null && sourceFile !== undefined) {
      const copy =
        code.length <= 1024 * 1024
          ? copySyntax(sourceFile as ts.SourceFile)
          : undefined;
      if (copy !== undefined) store.set(key, copy, code.length * 32 + 4096);
    }
    return result;
  },
};

// Resolve ESLint's own pinned parser; this does not select a project parser or
// introduce a second parser dependency/version.
const require = createRequire(import.meta.url);
const eslintRequire = createRequire(require.resolve("eslint"));
const espree = eslintRequire("espree") as {
  parse(code: string, options: unknown): object;
  version: string;
};
export const reuseJavascriptParser = {
  meta: { name: "zedbee-eslint-espree", version: espree.version },
  parse(code: string, options?: unknown) {
    const store = analysisStore<object>(javascriptSyntax);
    const key = store === undefined ? undefined : analysisKey([code, options]);
    if (key === undefined) return espree.parse(code, options);
    const ast = store!.get(key);
    if (ast !== undefined) {
      const copy = copySyntax(ast);
      if (copy !== undefined) return copy;
    }
    // ESLint attaches parents and analyzes scope after parsing. Each rule run
    // receives its own AST and therefore its own mutable scope metadata.
    const parsed = espree.parse(code, options);
    const copy = code.length <= 1024 * 1024 ? copySyntax(parsed) : undefined;
    if (copy !== undefined) store!.set(key, copy, code.length * 32 + 4096);
    return parsed;
  },
} satisfies Linter.Parser;
