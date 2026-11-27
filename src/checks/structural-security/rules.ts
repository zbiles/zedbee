import { extname } from "node:path";
import { Lang, type SgNode, type SgRoot } from "@ast-grep/napi";
import { parseStructuralSource, structuralNodes } from "./parser.js";
import { compareCodeUnits } from "../../core/compare.js";
import type { Observation, SourceLocation } from "../../core/types.js";
import { normalizeRepositoryRelativePath } from "../../attribution/fingerprint.js";
import { structuralSecurityIdentity } from "./fingerprint.js";

export interface StructuralRule {
  readonly id: string;
  readonly message: string;
  readonly remediation: string;
  matches(root: SgRoot): readonly SgNode[];
}

interface BindingSource {
  readonly kind: "import" | "declaration";
  readonly text: string;
}

interface RuleContext {
  readonly nodes: readonly SgNode[];
  text(node: SgNode | undefined): string | undefined;
  bindingSources(): readonly BindingSource[];
  readonly nonImportBindings: Map<string, boolean>;
}

interface ContextualStructuralRule extends Omit<StructuralRule, "matches"> {
  matches(context: RuleContext): readonly SgNode[];
}

function createRuleContext(
  nodes: readonly SgNode[],
  original?: string,
): RuleContext {
  const text = (node: SgNode | undefined): string | undefined => {
    if (node === undefined) return undefined;
    if (original === undefined) return node.text();
    const { start, end } = node.range();
    return original.slice(start.index, end.index);
  };
  let sources: readonly BindingSource[] | undefined;
  return {
    nodes,
    nonImportBindings: new Map(),
    text(node) {
      return node === undefined ? undefined : text(node);
    },
    bindingSources() {
      sources ??= nodes.flatMap((node): BindingSource[] => {
        const kind = node.kind();
        if (kind === "import_statement")
          return [{ kind: "import", text: text(node)! }];
        if (kind === "lexical_declaration" || kind === "variable_declaration")
          return [{ kind: "declaration", text: text(node)! }];
        return [];
      });
      return sources;
    },
  };
}

function namedChildren(node: SgNode): readonly SgNode[] {
  return node.children().filter((child) => child.isNamed());
}

function callCallee(node: SgNode): SgNode | undefined {
  return node.kind() === "call_expression" ? namedChildren(node)[0] : undefined;
}

function callArguments(node: SgNode): readonly SgNode[] {
  const args = namedChildren(node).find(
    (child) => child.kind() === "arguments",
  );
  return args === undefined ? [] : namedChildren(args);
}

function propertyName(context: RuleContext, node: SgNode): string | undefined {
  const children = namedChildren(node);
  if (node.kind() !== "pair" || children.length < 2) return undefined;
  return context.text(children[0])?.replace(/^['"]|['"]$/gu, "");
}

function propertyValue(node: SgNode): SgNode | undefined {
  return node.kind() === "pair" ? namedChildren(node)[1] : undefined;
}

function identifierNames(
  context: RuleContext,
  node: SgNode,
): ReadonlySet<string> {
  const names = new Set<string>();
  const visit = (candidate: SgNode): void => {
    if (candidate.kind() === "identifier") names.add(context.text(candidate)!);
    for (const child of candidate.children()) visit(child);
  };
  visit(node);
  return names;
}

interface ImportClause {
  readonly namespace: string | undefined;
  readonly defaultImport: string | undefined;
  readonly specifiers: readonly {
    readonly imported: string;
    readonly local: string;
  }[];
}

function parseImportClause(text: string): ImportClause {
  const namespace = text.match(
    /import\s+\*\s+as\s+([\p{ID_Start}_$][\p{ID_Continue}$]*)/u,
  )?.[1];
  const defaultImport = text.match(
    /import\s+([\p{ID_Start}_$][\p{ID_Continue}$]*)\s*(?:,|from)/u,
  )?.[1];
  const specifiers: { imported: string; local: string }[] = [];
  for (const specifier of text.match(/\{([^}]*)\}/u)?.[1]?.split(",") ?? []) {
    const match = specifier
      .trim()
      .match(
        /^([\p{ID_Start}_$][\p{ID_Continue}$]*)(?:\s+as\s+([\p{ID_Start}_$][\p{ID_Continue}$]*))?$/u,
      );
    if (match?.[1] !== undefined)
      specifiers.push({ imported: match[1], local: match[2] ?? match[1] });
  }
  return { namespace, defaultImport, specifiers };
}

function importLocalNames(text: string): ReadonlySet<string> {
  const { namespace, defaultImport, specifiers } = parseImportClause(text);
  const locals = new Set<string>();
  if (namespace !== undefined) locals.add(namespace);
  if (defaultImport !== undefined) locals.add(defaultImport);
  for (const { local } of specifiers) locals.add(local);
  return locals;
}

function hasNonImportBinding(context: RuleContext, name: string): boolean {
  const cached = context.nonImportBindings.get(name);
  if (cached !== undefined) return cached;
  const result = context.nodes.some((node) => {
    const kind = node.kind();
    if (kind === "formal_parameters")
      return identifierNames(context, node).has(name);
    if (kind === "arrow_function") {
      const parameter = namedChildren(node)[0];
      return (
        parameter?.kind() === "identifier" && context.text(parameter) === name
      );
    }
    if (kind === "variable_declarator") {
      const binding = namedChildren(node)[0];
      return (
        binding !== undefined && identifierNames(context, binding).has(name)
      );
    }
    if (
      kind === "function_declaration" ||
      kind === "function_expression" ||
      kind === "generator_function_declaration" ||
      kind === "generator_function" ||
      kind === "class_declaration" ||
      kind === "class"
    ) {
      return namedChildren(node).some(
        (child) =>
          child.kind() === "identifier" && context.text(child) === name,
      );
    }
    if (kind === "catch_clause") {
      const binding = namedChildren(node).find(
        (child) => child.kind() !== "statement_block",
      );
      return (
        binding !== undefined && identifierNames(context, binding).has(name)
      );
    }
    return false;
  });
  context.nonImportBindings.set(name, result);
  return result;
}

function hasAnyBinding(context: RuleContext, name: string): boolean {
  return (
    hasNonImportBinding(context, name) ||
    context
      .bindingSources()
      .some(
        (source) =>
          source.kind === "import" && importLocalNames(source.text).has(name),
      )
  );
}

function addRequireBindings(
  text: string,
  requirePattern: RegExp,
  namespaces: Set<string>,
  named: Map<string, string>,
): void {
  if (!requirePattern.test(text)) return;

  // A binding only counts when the declaration itself names it before the
  // require; an arrow wrapping a nested require must not bind its outer name.
  const namespacePattern = new RegExp(
    `^(?:const|let|var)\\s+([\\p{ID_Start}_$][\\p{ID_Continue}$]*)\\s*=\\s*${requirePattern.source}`,
    "u",
  );
  const destructurePattern = new RegExp(
    `^(?:const|let|var)\\s+\\{([^}]*)\\}\\s*=\\s*${requirePattern.source}`,
    "u",
  );
  const namespace = text.match(namespacePattern)?.[1];
  if (namespace !== undefined) namespaces.add(namespace);

  const specifiers = text.match(destructurePattern)?.[1];
  for (const specifier of specifiers?.split(",") ?? []) {
    const match = specifier
      .trim()
      .match(
        /^([\p{ID_Start}_$][\p{ID_Continue}$]*)(?:\s*:\s*([\p{ID_Start}_$][\p{ID_Continue}$]*))?$/u,
      );
    if (match?.[1] !== undefined) named.set(match[2] ?? match[1], match[1]);
  }
}

function addImportBindings(
  text: string,
  importPattern: RegExp,
  namespaces: Set<string>,
  named: Map<string, string>,
): void {
  if (!importPattern.test(text)) return;
  const clause = parseImportClause(text);
  if (clause.namespace !== undefined) namespaces.add(clause.namespace);
  if (clause.defaultImport !== undefined) namespaces.add(clause.defaultImport);
  for (const { imported, local } of clause.specifiers)
    named.set(local, imported);
}

function moduleBindings(
  context: RuleContext,
  moduleNames: readonly string[],
): { namespaces: ReadonlySet<string>; named: ReadonlyMap<string, string> } {
  const namespaces = new Set<string>();
  const named = new Map<string, string>();
  const modulePattern = moduleNames
    .map((name) => name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
    .join("|");
  const importPattern = new RegExp(`from\\s*['"](?:${modulePattern})['"]`, "u");
  const requirePattern = new RegExp(
    `require\\(\\s*['"](?:${modulePattern})['"]\\s*\\)`,
    "u",
  );
  for (const source of context.bindingSources()) {
    if (source.kind === "import") {
      addImportBindings(source.text, importPattern, namespaces, named);
      continue;
    }
    addRequireBindings(source.text, requirePattern, namespaces, named);
  }
  return { namespaces, named };
}

function isModuleCallee(
  context: RuleContext,
  callee: string,
  bindings: ReturnType<typeof moduleBindings>,
  methods: ReadonlySet<string>,
): boolean {
  const direct = bindings.named.get(callee);
  if (
    direct !== undefined &&
    methods.has(direct) &&
    !hasNonImportBinding(context, callee)
  )
    return true;
  const member = callee.match(
    /^([\p{ID_Start}_$][\p{ID_Continue}$]*)\.([\p{ID_Start}_$][\p{ID_Continue}$]*)$/u,
  );
  return (
    member?.[1] !== undefined &&
    bindings.namespaces.has(member[1]) &&
    !hasNonImportBinding(context, member[1]) &&
    methods.has(member[2] ?? "")
  );
}

function importedCalls(
  context: RuleContext,
  modules: readonly string[],
  methods: ReadonlySet<string>,
): readonly SgNode[] {
  const bindings = moduleBindings(context, modules);
  return context.nodes.filter((node) => {
    const callee = context.text(callCallee(node));
    if (callee === undefined) return false;
    return isModuleCallee(context, callee, bindings, methods);
  });
}

const directEval: ContextualStructuralRule = {
  id: "direct-eval",
  message: "Direct eval executes text as code in the current scope.",
  remediation: "Replace eval with a typed parser or an explicit operation map.",
  matches: (context) =>
    hasAnyBinding(context, "eval")
      ? []
      : context.nodes.filter(
          (node) =>
            node.kind() === "call_expression" &&
            context.text(callCallee(node)) === "eval",
        ),
};

const functionConstructor: ContextualStructuralRule = {
  id: "function-constructor",
  message: "The Function constructor compiles text as executable code.",
  remediation:
    "Replace dynamic code construction with ordinary functions or a constrained interpreter.",
  matches: (context) =>
    hasAnyBinding(context, "Function")
      ? []
      : context.nodes.filter((node) => {
          const kind = node.kind();
          if (kind === "call_expression")
            return context.text(callCallee(node)) === "Function";
          return (
            kind === "new_expression" &&
            context.text(namedChildren(node)[0]) === "Function"
          );
        }),
};

const childProcessExec: ContextualStructuralRule = {
  id: "child-process-string-exec",
  message: "child_process.exec passes a command string through a shell.",
  remediation:
    "Use execFile or spawn with a fixed executable and a separate argument array.",
  matches: (context) =>
    importedCalls(
      context,
      ["child_process", "node:child_process"],
      new Set(["exec", "execSync"]),
    ),
};

const dynamicVm: ContextualStructuralRule = {
  id: "dynamic-vm-execution",
  message: "The Node vm API executes dynamically supplied code.",
  remediation:
    "Avoid executing untrusted text; use a constrained parser or isolate execution outside the process.",
  matches: (context) =>
    importedCalls(
      context,
      ["vm", "node:vm"],
      new Set(["runInContext", "runInNewContext", "runInThisContext"]),
    ),
};

const tlsDisabled: ContextualStructuralRule = {
  id: "tls-verification-disabled",
  message: "TLS certificate verification is explicitly disabled.",
  remediation:
    "Remove rejectUnauthorized: false and use a trusted CA configuration.",
  matches: (context) =>
    context.nodes.filter(
      (node) =>
        propertyName(context, node) === "rejectUnauthorized" &&
        propertyValue(node)?.kind() === "false",
    ),
};

const PASSWORD_VALUE = /\b(?:password|passwd|pwd)\b/iu;
const WEAK_HASH = /^(?:['"])(?:md5|sha-?1)(?:['"])$/iu;

const CREATE_HASH = new Set(["createHash"]);

function isWeakHashCall(
  context: RuleContext,
  node: SgNode,
  bindings: ReturnType<typeof moduleBindings>,
): boolean {
  const callee = context.text(callCallee(node));
  return (
    callee !== undefined &&
    isModuleCallee(context, callee, bindings, CREATE_HASH) &&
    WEAK_HASH.test(context.text(callArguments(node)[0]) ?? "")
  );
}

const weakPasswordHash: ContextualStructuralRule = {
  id: "weak-password-hash",
  message: "MD5 and SHA-1 are unsuitable for password hashing.",
  remediation:
    "Use a password-hashing function such as scrypt, Argon2, or bcrypt with appropriate parameters.",
  matches(context) {
    const bindings = moduleBindings(context, ["crypto", "node:crypto"]);
    return context.nodes.filter((node) => {
      if (node.kind() !== "call_expression") return false;
      const callee = callCallee(node);
      if (callee?.kind() !== "member_expression") return false;
      const parts = namedChildren(callee);
      if (context.text(parts.at(-1)) !== "update") return false;
      const receiver = parts[0];
      return (
        receiver !== undefined &&
        isWeakHashCall(context, receiver, bindings) &&
        PASSWORD_VALUE.test(context.text(callArguments(node)[0]) ?? "")
      );
    });
  },
};

const CREDENTIAL_PROPERTY =
  /^(?:authorization|cookie|api[-_]?key|token|auth)$/iu;

function staticString(
  context: RuleContext,
  node: SgNode | undefined,
): string | undefined {
  if (node?.kind() !== "string") return undefined;
  const text = context.text(node)!;
  return text.length >= 2 ? text.slice(1, -1) : undefined;
}

const REQUEST = new Set(["request"]);

function isRequestOptions(
  context: RuleContext,
  node: SgNode,
  bindings: ReturnType<typeof moduleBindings>,
): boolean {
  const args = node.parent();
  const call = args?.parent();
  if (args?.kind() !== "arguments" || call?.kind() !== "call_expression")
    return false;
  const callee = context.text(callCallee(call)) ?? "";
  return (
    (bindings.namespaces.has(callee) &&
      !hasNonImportBinding(context, callee)) ||
    isModuleCallee(context, callee, bindings, REQUEST)
  );
}

const EMPTY_CREDENTIAL_VALUES: ReadonlySet<string> = new Set([
  "undefined",
  "null",
  "false",
  '""',
  "''",
  "``",
  "void 0",
]);

function hasCredentialValue(context: RuleContext, node: SgNode): boolean {
  if (!CREDENTIAL_PROPERTY.test(propertyName(context, node) ?? ""))
    return false;
  const value = context.text(propertyValue(node))?.trim();
  return value !== undefined && !EMPTY_CREDENTIAL_VALUES.has(value);
}

function callHasStaticHttpUrl(context: RuleContext, node: SgNode): boolean {
  const args = node.parent();
  const call = args?.parent();
  return (
    call?.kind() === "call_expression" &&
    callArguments(call).some((argument) =>
      staticString(context, argument)?.startsWith("http://"),
    )
  );
}

const insecureCredentialRequest: ContextualStructuralRule = {
  id: "credential-over-insecure-http",
  message: "Credentials are attached to a request using an insecure HTTP URL.",
  remediation:
    "Use HTTPS and keep credentials out of URLs and plaintext transports.",
  matches(context) {
    const bindings = moduleBindings(context, [
      "request",
      "http",
      "node:http",
      "https",
      "node:https",
    ]);
    return context.nodes.filter((node) => {
      if (
        node.kind() !== "object" ||
        !isRequestOptions(context, node, bindings)
      )
        return false;
      const descendants = [node, ...node.findAll({ rule: { kind: "pair" } })];
      const insecureUrl =
        descendants.some((candidate) => {
          const key = propertyName(context, candidate);
          return (
            (key === "url" || key === "uri" || key === "href") &&
            staticString(context, propertyValue(candidate))?.startsWith(
              "http://",
            )
          );
        }) || callHasStaticHttpUrl(context, node);
      const hasCredentials = descendants.some((candidate) =>
        hasCredentialValue(context, candidate),
      );
      return insecureUrl && hasCredentials;
    });
  },
};

const contextualRules: readonly ContextualStructuralRule[] = Object.freeze([
  directEval,
  functionConstructor,
  childProcessExec,
  dynamicVm,
  tlsDisabled,
  weakPasswordHash,
  insecureCredentialRequest,
]);

// Standalone rule calls get fresh state, even if a caller reuses a root wrapper.
// The collector instead shares one context for its immutable parsed source.
export const structuralRules: readonly StructuralRule[] = Object.freeze(
  contextualRules.map((rule) => ({
    ...rule,
    matches: (root: SgRoot) =>
      rule.matches(createRuleContext(structuralNodes(root))),
  })),
);

function languageFor(file: string): Lang {
  switch (extname(file).toLowerCase()) {
    case ".jsx":
    case ".tsx":
      return Lang.Tsx;
    case ".ts":
    case ".mts":
    case ".cts":
      return Lang.TypeScript;
    case ".js":
    case ".mjs":
    case ".cjs":
      return Lang.JavaScript;
    default:
      throw new Error("Structural security analysis failed.");
  }
}

function location(file: string, node: SgNode): SourceLocation {
  const range = node.range();
  return {
    file,
    startLine: range.start.line + 1,
    startColumn: range.start.column + 1,
    endLine: range.end.line + 1,
    endColumn: range.end.column + 1,
  };
}

export function collectStructuralSecurityObservations(
  file: string,
  source: string,
): readonly Observation[] {
  const normalizedFile = normalizeRepositoryRelativePath(file);
  const { nodes, normalized } = parseStructuralSource(
    languageFor(normalizedFile),
    normalizedFile,
    source,
  );
  const context = createRuleContext(nodes, normalized ? source : undefined);
  const observations = contextualRules.flatMap((rule) =>
    rule.matches(context).map((match): Observation => {
      const normalizedLocation = location(normalizedFile, match);
      return {
        check: "structuralSecurity",
        rule: rule.id,
        identity: structuralSecurityIdentity(rule.id, normalizedLocation),
        severity: "error",
        message: rule.message,
        remediation: rule.remediation,
        location: normalizedLocation,
      };
    }),
  );
  return Object.freeze(
    observations.sort((left, right) =>
      compareCodeUnits(left.identity, right.identity),
    ),
  );
}
