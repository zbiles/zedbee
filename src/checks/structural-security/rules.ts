import { extname } from "node:path";
import { Lang, parse, type SgNode, type SgRoot } from "@ast-grep/napi";
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

function nodes(root: SgRoot): readonly SgNode[] {
  const found: SgNode[] = [];
  const visit = (node: SgNode): void => {
    found.push(node);
    for (const child of node.children()) visit(child);
  };
  visit(root.root());
  return found;
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

function propertyName(node: SgNode): string | undefined {
  const children = namedChildren(node);
  if (node.kind() !== "pair" || children.length < 2) return undefined;
  return children[0]?.text().replace(/^['"]|['"]$/gu, "");
}

function propertyValue(node: SgNode): SgNode | undefined {
  return node.kind() === "pair" ? namedChildren(node)[1] : undefined;
}

function identifierNames(node: SgNode): ReadonlySet<string> {
  const names = new Set<string>();
  const visit = (candidate: SgNode): void => {
    if (candidate.kind() === "identifier") names.add(candidate.text());
    for (const child of candidate.children()) visit(child);
  };
  visit(node);
  return names;
}

function importLocalNames(node: SgNode): ReadonlySet<string> {
  const locals = new Set<string>();
  const text = node.text();
  const namespace = text.match(
    /import\s+\*\s+as\s+([\p{ID_Start}_$][\p{ID_Continue}$]*)/u,
  )?.[1];
  const defaultImport = text.match(
    /import\s+([\p{ID_Start}_$][\p{ID_Continue}$]*)\s*(?:,|from)/u,
  )?.[1];
  if (namespace !== undefined) locals.add(namespace);
  if (defaultImport !== undefined) locals.add(defaultImport);
  for (const specifier of text.match(/\{([^}]*)\}/u)?.[1]?.split(",") ?? []) {
    const match = specifier
      .trim()
      .match(
        /^([\p{ID_Start}_$][\p{ID_Continue}$]*)(?:\s+as\s+([\p{ID_Start}_$][\p{ID_Continue}$]*))?$/u,
      );
    if (match?.[1] !== undefined) locals.add(match[2] ?? match[1]);
  }
  return locals;
}

function hasNonImportBinding(root: SgRoot, name: string): boolean {
  return nodes(root).some((node) => {
    const kind = node.kind();
    if (kind === "formal_parameters") return identifierNames(node).has(name);
    if (kind === "arrow_function") {
      const parameter = namedChildren(node)[0];
      return parameter?.kind() === "identifier" && parameter.text() === name;
    }
    if (kind === "variable_declarator") {
      const binding = namedChildren(node)[0];
      return binding !== undefined && identifierNames(binding).has(name);
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
        (child) => child.kind() === "identifier" && child.text() === name,
      );
    }
    if (kind === "catch_clause") {
      const binding = namedChildren(node).find(
        (child) => child.kind() !== "statement_block",
      );
      return binding !== undefined && identifierNames(binding).has(name);
    }
    return false;
  });
}

function hasAnyBinding(root: SgRoot, name: string): boolean {
  return (
    hasNonImportBinding(root, name) ||
    nodes(root).some(
      (node) =>
        node.kind() === "import_statement" && importLocalNames(node).has(name),
    )
  );
}

function moduleBindings(
  root: SgRoot,
  moduleNames: readonly string[],
): { namespaces: ReadonlySet<string>; named: ReadonlyMap<string, string> } {
  const namespaces = new Set<string>();
  const named = new Map<string, string>();
  const modulePattern = moduleNames
    .map((name) => name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
    .join("|");
  for (const node of nodes(root)) {
    if (node.kind() === "import_statement") {
      const text = node.text();
      if (!new RegExp(`from\\s*['"](?:${modulePattern})['"]`, "u").test(text))
        continue;
      const namespace = text.match(
        /import\s+\*\s+as\s+([\p{ID_Start}_$][\p{ID_Continue}$]*)/u,
      )?.[1];
      const defaultImport = text.match(
        /import\s+([\p{ID_Start}_$][\p{ID_Continue}$]*)\s*(?:,|from)/u,
      )?.[1];
      if (namespace !== undefined) namespaces.add(namespace);
      if (defaultImport !== undefined) namespaces.add(defaultImport);
      const specifiers = text.match(/\{([^}]*)\}/u)?.[1];
      for (const specifier of specifiers?.split(",") ?? []) {
        const match = specifier
          .trim()
          .match(
            /^([\p{ID_Start}_$][\p{ID_Continue}$]*)(?:\s+as\s+([\p{ID_Start}_$][\p{ID_Continue}$]*))?$/u,
          );
        if (match?.[1] !== undefined) named.set(match[2] ?? match[1], match[1]);
      }
    }
    if (
      node.kind() === "lexical_declaration" ||
      node.kind() === "variable_declaration"
    ) {
      const text = node.text();
      const required = new RegExp(
        `require\\(\\s*['"](?:${modulePattern})['"]\\s*\\)`,
        "u",
      );
      if (!required.test(text)) continue;
      const namespace = text.match(
        /(?:const|let|var)\s+([\p{ID_Start}_$][\p{ID_Continue}$]*)\s*=/u,
      )?.[1];
      if (namespace !== undefined) namespaces.add(namespace);
      const specifiers = text.match(
        /(?:const|let|var)\s+\{([^}]*)\}\s*=/u,
      )?.[1];
      for (const specifier of specifiers?.split(",") ?? []) {
        const match = specifier
          .trim()
          .match(
            /^([\p{ID_Start}_$][\p{ID_Continue}$]*)(?:\s*:\s*([\p{ID_Start}_$][\p{ID_Continue}$]*))?$/u,
          );
        if (match?.[1] !== undefined) named.set(match[2] ?? match[1], match[1]);
      }
    }
  }
  return { namespaces, named };
}

function importedCalls(
  root: SgRoot,
  modules: readonly string[],
  methods: ReadonlySet<string>,
): readonly SgNode[] {
  const bindings = moduleBindings(root, modules);
  return nodes(root).filter((node) => {
    const callee = callCallee(node)?.text();
    if (callee === undefined) return false;
    const direct = bindings.named.get(callee);
    if (
      direct !== undefined &&
      methods.has(direct) &&
      !hasNonImportBinding(root, callee)
    )
      return true;
    const member = callee.match(
      /^([\p{ID_Start}_$][\p{ID_Continue}$]*)\.([\p{ID_Start}_$][\p{ID_Continue}$]*)$/u,
    );
    return (
      member?.[1] !== undefined &&
      bindings.namespaces.has(member[1]) &&
      !hasNonImportBinding(root, member[1]) &&
      methods.has(member[2] ?? "")
    );
  });
}

const directEval: StructuralRule = {
  id: "direct-eval",
  message: "Direct eval executes text as code in the current scope.",
  remediation: "Replace eval with a typed parser or an explicit operation map.",
  matches: (root) =>
    hasAnyBinding(root, "eval")
      ? []
      : nodes(root).filter(
          (node) =>
            node.kind() === "call_expression" &&
            callCallee(node)?.text() === "eval",
        ),
};

const functionConstructor: StructuralRule = {
  id: "function-constructor",
  message: "The Function constructor compiles text as executable code.",
  remediation:
    "Replace dynamic code construction with ordinary functions or a constrained interpreter.",
  matches: (root) =>
    hasAnyBinding(root, "Function")
      ? []
      : nodes(root).filter((node) => {
          const kind = node.kind();
          if (kind === "call_expression")
            return callCallee(node)?.text() === "Function";
          return (
            kind === "new_expression" &&
            namedChildren(node)[0]?.text() === "Function"
          );
        }),
};

const childProcessExec: StructuralRule = {
  id: "child-process-string-exec",
  message: "child_process.exec passes a command string through a shell.",
  remediation:
    "Use execFile or spawn with a fixed executable and a separate argument array.",
  matches: (root) =>
    importedCalls(
      root,
      ["child_process", "node:child_process"],
      new Set(["exec", "execSync"]),
    ),
};

const dynamicVm: StructuralRule = {
  id: "dynamic-vm-execution",
  message: "The Node vm API executes dynamically supplied code.",
  remediation:
    "Avoid executing untrusted text; use a constrained parser or isolate execution outside the process.",
  matches: (root) =>
    importedCalls(
      root,
      ["vm", "node:vm"],
      new Set(["runInContext", "runInNewContext", "runInThisContext"]),
    ),
};

const tlsDisabled: StructuralRule = {
  id: "tls-verification-disabled",
  message: "TLS certificate verification is explicitly disabled.",
  remediation:
    "Remove rejectUnauthorized: false and use a trusted CA configuration.",
  matches: (root) =>
    nodes(root).filter(
      (node) =>
        propertyName(node) === "rejectUnauthorized" &&
        propertyValue(node)?.kind() === "false",
    ),
};

const PASSWORD_VALUE = /\b(?:password|passwd|pwd)\b/iu;
const WEAK_HASH = /^(?:['"])(?:md5|sha-?1)(?:['"])$/iu;

function isWeakHashCall(
  root: SgRoot,
  node: SgNode,
  bindings: ReturnType<typeof moduleBindings>,
): boolean {
  const callee = callCallee(node)?.text();
  if (callee === undefined) return false;
  const direct =
    bindings.named.get(callee) === "createHash" &&
    !hasNonImportBinding(root, callee);
  const member = callee.match(
    /^([\p{ID_Start}_$][\p{ID_Continue}$]*)\.createHash$/u,
  );
  const namespaced =
    member?.[1] !== undefined &&
    bindings.namespaces.has(member[1]) &&
    !hasNonImportBinding(root, member[1]);
  return (
    (direct || namespaced) &&
    WEAK_HASH.test(callArguments(node)[0]?.text() ?? "")
  );
}

const weakPasswordHash: StructuralRule = {
  id: "weak-password-hash",
  message: "MD5 and SHA-1 are unsuitable for password hashing.",
  remediation:
    "Use a password-hashing function such as scrypt, Argon2, or bcrypt with appropriate parameters.",
  matches(root) {
    const bindings = moduleBindings(root, ["crypto", "node:crypto"]);
    return nodes(root).filter((node) => {
      if (node.kind() !== "call_expression") return false;
      const callee = callCallee(node);
      if (callee?.kind() !== "member_expression") return false;
      const parts = namedChildren(callee);
      if (parts.at(-1)?.text() !== "update") return false;
      const receiver = parts[0];
      return (
        receiver !== undefined &&
        isWeakHashCall(root, receiver, bindings) &&
        PASSWORD_VALUE.test(callArguments(node)[0]?.text() ?? "")
      );
    });
  },
};

const CREDENTIAL_PROPERTY =
  /^(?:authorization|cookie|api[-_]?key|token|auth)$/iu;

function staticString(node: SgNode | undefined): string | undefined {
  if (node?.kind() !== "string") return undefined;
  const text = node.text();
  return text.length >= 2 ? text.slice(1, -1) : undefined;
}

function isRequestOptions(
  root: SgRoot,
  node: SgNode,
  bindings: ReturnType<typeof moduleBindings>,
): boolean {
  const args = node.parent();
  const call = args?.parent();
  if (args?.kind() !== "arguments" || call?.kind() !== "call_expression")
    return false;
  const callee = callCallee(call)?.text() ?? "";
  const direct =
    (bindings.namespaces.has(callee) ||
      bindings.named.get(callee) === "request") &&
    !hasNonImportBinding(root, callee);
  const member = callee.match(
    /^([\p{ID_Start}_$][\p{ID_Continue}$]*)\.request$/u,
  );
  const namespaced =
    member?.[1] !== undefined &&
    bindings.namespaces.has(member[1]) &&
    !hasNonImportBinding(root, member[1]);
  return direct || namespaced;
}

function hasCredentialValue(node: SgNode): boolean {
  if (!CREDENTIAL_PROPERTY.test(propertyName(node) ?? "")) return false;
  const value = propertyValue(node)?.text().trim();
  return (
    value !== undefined &&
    !new Set(["undefined", "null", "false", '""', "''", "``", "void 0"]).has(
      value,
    )
  );
}

function callHasStaticHttpUrl(node: SgNode): boolean {
  const args = node.parent();
  const call = args?.parent();
  return (
    call?.kind() === "call_expression" &&
    callArguments(call).some((argument) =>
      staticString(argument)?.startsWith("http://"),
    )
  );
}

const insecureCredentialRequest: StructuralRule = {
  id: "credential-over-insecure-http",
  message: "Credentials are attached to a request using an insecure HTTP URL.",
  remediation:
    "Use HTTPS and keep credentials out of URLs and plaintext transports.",
  matches(root) {
    const bindings = moduleBindings(root, [
      "request",
      "http",
      "node:http",
      "https",
      "node:https",
    ]);
    return nodes(root).filter((node) => {
      if (node.kind() !== "object" || !isRequestOptions(root, node, bindings))
        return false;
      const descendants = [node, ...node.findAll({ rule: { kind: "pair" } })];
      const insecureUrl =
        descendants.some((candidate) => {
          const key = propertyName(candidate);
          return (
            (key === "url" || key === "uri" || key === "href") &&
            staticString(propertyValue(candidate))?.startsWith("http://")
          );
        }) || callHasStaticHttpUrl(node);
      const hasCredentials = descendants.some(hasCredentialValue);
      return insecureUrl && hasCredentials;
    });
  },
};

export const structuralRules: readonly StructuralRule[] = Object.freeze([
  directEval,
  functionConstructor,
  childProcessExec,
  dynamicVm,
  tlsDisabled,
  weakPasswordHash,
  insecureCredentialRequest,
]);

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
  try {
    const normalizedFile = normalizeRepositoryRelativePath(file);
    const root = parse(languageFor(normalizedFile), source);
    const parsedNodes = nodes(root);
    if (
      parsedNodes.some(
        (node, index) =>
          node.kind() === "ERROR" ||
          (index > 0 && node.range().start.index === node.range().end.index),
      )
    )
      throw new Error("parse failed");
    const observations = structuralRules.flatMap((rule) =>
      rule.matches(root).map((match): Observation => {
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
  } catch {
    throw new Error("Structural security analysis failed.");
  }
}
