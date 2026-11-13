import { realpathSync } from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";
import { resolve } from "node:path";
import type { CheckObservationSet, CheckRunContext } from "./adapter.js";
import type { Observation, Finding } from "../core/types.js";
import { fingerprintObservation } from "../attribution/fingerprint.js";
import { capturedSourceRegistry } from "../inspection/source-capture.js";
import { captureSnapshotRegistry } from "../inspection/snapshot-registry.js";
import { readContainedFile } from "../inspection/read-json.js";

export type DiagnosticRedactionReason =
  | "sensitive-value"
  | "context-unavailable"
  | "unsupported-template"
  | "source-free-policy";
export interface DiagnosticDetail {
  readonly findingId: string;
  readonly message: string;
  readonly redaction?: {
    readonly redacted: true;
    readonly reasons: readonly DiagnosticRedactionReason[];
  };
}
interface Pending {
  observation: Observation;
  original: string;
  root: string;
  source?: string;
}
interface DetailScope {
  items: Pending[];
  targetRoot: string;
  proseBytes: number;
  sourceBytes: number;
  sources: Set<string>;
}
const pending = new AsyncLocalStorage<DetailScope>();
const sessions = new AsyncLocalStorage<
  Map<string, DiagnosticDetail & { sourceFreeMessage: string }>
>();
const canonicalRoot = (root: string) => {
  try {
    return realpathSync(root);
  } catch {
    return resolve(root);
  }
};
const managed = new Set([
  "types",
  "lint",
  "reactCorrectness",
  "reactAccessibility",
]);
const reasons = new Set<DiagnosticRedactionReason>([
  "sensitive-value",
  "context-unavailable",
  "unsupported-template",
  "source-free-policy",
]);
const safeText = (s: string) =>
  s
    .replace(/[\p{Cc}\p{Cf}\u2028\u2029]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 4096);

/** Raw upstream prose lives only inside a bounded collect scope, never in observations. */
export function recordDiagnosticDetail(
  observation: Observation,
  original: string,
  root: string,
  source?: string,
): void {
  const scope = pending.getStore();
  if (!scope || canonicalRoot(root) !== scope.targetRoot) return;
  const list = scope.items;
  if (
    !managed.has(observation.check) ||
    list.length >= 256 ||
    original.length > 16384 ||
    (source?.length ?? 0) > 1024 * 1024
  )
    return;
  if (scope.proseBytes + original.length * 2 > 1024 * 1024) return;
  if (source !== undefined && !scope.sources.has(source)) {
    if (scope.sourceBytes + source.length * 2 > 8 * 1024 * 1024) return;
    scope.sources.add(source);
    scope.sourceBytes += source.length * 2;
  }
  scope.proseBytes += original.length * 2;
  list.push({
    observation,
    original,
    root,
    ...(source === undefined ? {} : { source }),
  });
}
function key(observation: Observation) {
  return fingerprintObservation(observation);
}
function withheld(
  observation: Observation,
  reason: DiagnosticRedactionReason,
): DiagnosticDetail {
  return {
    findingId: fingerprintObservation(observation),
    message: observation.message.replaceAll("[source]", "[redacted detail]"),
    redaction: { redacted: true, reasons: [reason] },
  };
}
// Only template shapes whose substitutions are names/specifiers are supported.
// Type representations and arbitrary compiler prose can embed source literals.
function supported(rule: string, message: string): boolean {
  if (rule === "@typescript-eslint/require-await")
    return /^(?:Async (?:arrow function|function(?: '[^']+')?|method(?: '[^']+')?)|(?:Async generator function)) has no 'await' expression\.$/u.test(
      message,
    );
  if (["@typescript-eslint/no-unused-vars", "no-unused-vars"].includes(rule))
    return /^'[^'\r\n]+' is (?:defined|assigned a value) but never used(?:\. Allowed unused [^\r\n]+)?\.$/u.test(
      message,
    );
  if (rule === "react/no-unknown-property")
    return /^Unknown property '[^'\r\n]+' found(?:, use '[^'\r\n]+' instead)?$/u.test(
      message,
    );
  if (rule === "typescript/TS2305")
    return /^Module '[^'\r\n]+' has no exported member '[^'\r\n]+'\.$/u.test(
      message,
    );
  if (rule === "typescript/TS2875")
    return /^This JSX tag requires the module path '[^'\r\n]+' to exist, but none could be found\./u.test(
      message,
    );
  if (rule === "typescript/TS2307")
    return /^Cannot find module '[^'\r\n]+' or its corresponding type declarations\.$/u.test(
      message,
    );
  if (rule === "typescript/TS2339")
    return /^Property '[A-Za-z_$][\w$]*' does not exist on type '[A-Za-z_$][\w$.]*(?:<[^'"<>]+>)?'\.$/u.test(
      message,
    );
  if (rule === "typescript/TS2551")
    return /^Property '[A-Za-z_$][\w$]*' does not exist on type '[A-Za-z_$][\w$.]*'\. Did you mean '[A-Za-z_$][\w$]*'\?$/u.test(
      message,
    );
  if (rule === "typescript/TS2304")
    return /^Cannot find name '[^'\r\n]+'\.$/u.test(message);
  return false;
}
async function reviewed(
  item: Pending,
  source: string | undefined,
  secretCache: Map<string, Promise<readonly string[]>>,
): Promise<DiagnosticDetail> {
  const { observation, original } = item;
  if (original === observation.message)
    return {
      findingId: fingerprintObservation(observation),
      message: observation.message,
    };
  if (!supported(observation.rule, original))
    return withheld(observation, "unsupported-template");
  // Pure upstream function-category vocabulary does not require source access.
  if (
    observation.rule === "@typescript-eslint/require-await" &&
    /^Async (?:arrow function|function|method|generator function) has no 'await' expression\.$/u.test(
      original,
    )
  )
    return {
      findingId: fingerprintObservation(observation),
      message: original,
    };
  if (source === undefined)
    return withheld(
      observation,
      supportsContextualRule(observation.rule)
        ? "context-unavailable"
        : "unsupported-template",
    );
  // JSX import source can come from configuration or a declaration outside this
  // diagnostic's captured file. Do not treat an arbitrary runtime name as proven.
  if (
    observation.rule === "typescript/TS2875" &&
    !/^This JSX tag requires the module path 'react\/jsx(?:-dev)?-runtime'/u.test(
      original,
    )
  )
    return withheld(
      observation,
      supportsContextualRule(observation.rule)
        ? "context-unavailable"
        : "unsupported-template",
    );
  let redacted = false;
  let rendered = original.replace(/'([^']+)'/gu, (quoted, value: string) => {
    if (
      /(?:[A-Za-z]:[\\/]|https?:\/\/|postgres(?:ql)?:\/\/|^\/)/u.test(value)
    ) {
      redacted = true;
      return "'[redacted module]'";
    }
    return quoted;
  });
  try {
    const { lintSource } = await import("@secretlint/core");
    const { SECRET_LINT_CONFIG } = await import("./secrets/config.js");
    const secretKey = (observation.location?.file ?? "") + "\0" + source;
    let values = secretCache.get(secretKey);
    if (values === undefined) {
      values = (async () => {
        const result = await lintSource({
          source: {
            content: source,
            filePath: observation.location?.file ?? "diagnostic.ts",
            contentType: "text",
          },
          options: {
            config: SECRET_LINT_CONFIG,
            maskSecrets: true,
            noPhysicFilePath: true,
          },
        });
        const found = result.messages.flatMap((message) =>
          message.range
            ? [source.slice(message.range[0], message.range[1])]
            : [],
        );
        // Context-only credentials may not have an independently recognizable token shape.
        for (const match of source.matchAll(
          /(?:secret|password|token|credential|api[_-]?key|access[_-]?key)[\w-]*["']?\s*[:=]\s*["']([^"'\r\n]+)["']/giu,
        ))
          if (match[1]) found.push(match[1]);
        return found.filter((value) => value.length > 0);
      })();
      secretCache.set(secretKey, values);
    }
    for (const value of await values)
      if (rendered.includes(value)) {
        rendered = rendered.replaceAll(value, "[redacted value]");
        redacted = true;
      }
    const direct = await lintSource({
      source: {
        content: original,
        filePath: "diagnostic.txt",
        contentType: "text",
      },
      options: {
        config: SECRET_LINT_CONFIG,
        maskSecrets: true,
        noPhysicFilePath: true,
      },
    });
    for (const message of direct.messages) {
      if (!message.range) return withheld(observation, "sensitive-value");
      const value = original.slice(message.range[0], message.range[1]);
      if (!value) return withheld(observation, "sensitive-value");
      if (rendered.includes(value)) {
        rendered = rendered.replaceAll(value, "[redacted value]");
        redacted = true;
      }
    }
  } catch {
    return withheld(
      observation,
      supportsContextualRule(observation.rule)
        ? "context-unavailable"
        : "unsupported-template",
    );
  }
  return {
    findingId: fingerprintObservation(observation),
    message: safeText(rendered),
    ...(redacted
      ? {
          redaction: {
            redacted: true as const,
            reasons: ["sensitive-value" as const],
          },
        }
      : {}),
  };
}

export async function captureDiagnosticDetails(
  context: CheckRunContext,
  collect: () => Promise<CheckObservationSet>,
): Promise<CheckObservationSet> {
  // Remote adapters already return reviewed details from their worker scope.
  if (context.config?.reporting?.diagnosticMessages === "source-free")
    return collect();
  const list: Pending[] = [];
  const scope: DetailScope = {
    items: list,
    targetRoot: canonicalRoot(context.snapshots.targetDir),
    proseBytes: 0,
    sourceBytes: 0,
    sources: new Set(),
  };
  return pending.run(scope, async () => {
    try {
      const set = await collect();
      if (!managed.has(set.checkId) || set.diagnosticDetails !== undefined)
        return set;
      const target = new Map(set.targetObservations.map((o) => [key(o), o]));
      const sourceCache = new Map<string, Promise<string | undefined>>();
      const details: DiagnosticDetail[] = [];
      const secretCache = new Map<string, Promise<readonly string[]>>();
      let bytes = 0;
      let fallbackSourceBytes = 0;
      for (const item of list) {
        if (
          canonicalRoot(item.root) !==
          canonicalRoot(context.snapshots.targetDir)
        )
          continue;
        const observation = target.get(key(item.observation));
        if (!observation) continue;
        context.signal.throwIfAborted();
        let source = item.source;
        const file = observation.location?.file;
        if (source === undefined && file !== undefined) {
          let read = sourceCache.get(file);
          if (!read) {
            read = (async () => {
              try {
                const registry =
                  capturedSourceRegistry(context.snapshots.targetDir, [file]) ??
                  (await captureSnapshotRegistry(context.snapshots.targetDir, [
                    file,
                  ]));
                const text = await readContainedFile(registry, file, {
                  maxBytes: 1024 * 1024,
                });
                if (
                  text.length > 1024 * 1024 ||
                  fallbackSourceBytes + text.length * 2 + scope.sourceBytes >
                    8 * 1024 * 1024
                )
                  return undefined;
                fallbackSourceBytes += text.length * 2;
                return text;
              } catch {
                return undefined;
              }
            })();
            sourceCache.set(file, read);
          }
          source = await read;
        }
        const detail = await reviewed(
          { ...item, observation },
          source,
          secretCache,
        );
        bytes += detail.message.length * 2;
        if (bytes > 1024 * 1024) break;
        details.push(detail);
      }
      list.length = 0;
      return details.length === 0
        ? set
        : { ...set, diagnosticDetails: details };
    } finally {
      list.length = 0;
      scope.sources.clear();
    }
  });
}
export function sanitizeDiagnosticDetails(
  value: unknown,
): readonly DiagnosticDetail[] {
  if (!Array.isArray(value) || value.length > 256)
    throw new TypeError("Invalid diagnostic details");
  let bytes = 0;
  return value.map((v) => {
    if (
      !v ||
      typeof v.findingId !== "string" ||
      !/^[a-f0-9]{64}$/u.test(v.findingId) ||
      typeof v.message !== "string" ||
      v.message.length > 4096 ||
      safeText(v.message) !== v.message
    )
      throw new TypeError("Invalid diagnostic detail");
    bytes += v.message.length * 2;
    if (bytes > 1024 * 1024)
      throw new TypeError("Diagnostic detail budget exceeded");
    let redaction: DiagnosticDetail["redaction"];
    if (v.redaction !== undefined) {
      if (
        v.redaction.redacted !== true ||
        !Array.isArray(v.redaction.reasons) ||
        v.redaction.reasons.length > 4 ||
        v.redaction.reasons.some(
          (r: DiagnosticRedactionReason) => !reasons.has(r),
        )
      )
        throw new TypeError("Invalid diagnostic redaction");
      redaction = { redacted: true, reasons: [...v.redaction.reasons] };
    }
    return {
      findingId: v.findingId,
      message: v.message,
      ...(redaction ? { redaction } : {}),
    };
  });
}
export function retainDiagnosticDetails(set: CheckObservationSet): void {
  const store = sessions.getStore();
  if (!store || !managed.has(set.checkId)) return;
  const targets = new Map(
    set.targetObservations.map((observation) => [
      fingerprintObservation(observation),
      observation,
    ]),
  );
  for (const [id, observation] of targets)
    if (store.size < 4096)
      store.set(id, {
        ...(observation.message.includes("[source]")
          ? withheld(
              observation,
              supportsContextualRule(observation.rule)
                ? "context-unavailable"
                : "unsupported-template",
            )
          : { findingId: id, message: observation.message }),
        sourceFreeMessage: observation.message,
      });
  for (const detail of sanitizeDiagnosticDetails(set.diagnosticDetails ?? [])) {
    const observation = targets.get(detail.findingId);
    if (observation && store.has(detail.findingId))
      store.set(detail.findingId, {
        ...detail,
        sourceFreeMessage: observation.message,
      });
  }
}
export function withDiagnosticDetailSession<T>(
  callback: () => Promise<T>,
): Promise<T> {
  return sessions.run(new Map(), async () => {
    try {
      return await callback();
    } finally {
      sessions.getStore()?.clear();
    }
  });
}
export function applyDiagnosticDetails<
  T extends {
    checks: readonly { findings: readonly Finding[] }[];
    summary: { findings: readonly Finding[] };
  },
>(report: T, policy: "contextual" | "source-free"): T {
  const store = sessions.getStore();
  const render = (finding: Finding): Finding => {
    if (!managed.has(finding.check)) return finding;
    const detail = store?.get(finding.id);
    // Project ESLint never registers in this managed-only store.
    if (!detail) return finding;
    if (policy === "source-free")
      return {
        ...finding,
        message: detail.sourceFreeMessage,
        ...(detail.sourceFreeMessage.includes("[source]")
          ? {
              messageRedaction: {
                redacted: true as const,
                reasons: ["source-free-policy" as const],
              },
            }
          : {}),
      };
    return {
      ...finding,
      message: detail.message,
      ...(detail.redaction ? { messageRedaction: detail.redaction } : {}),
    };
  };
  return {
    ...report,
    checks: report.checks.map((c) => ({
      ...c,
      findings: c.findings.map(render),
    })),
    summary: {
      ...report.summary,
      findings: report.summary.findings.map(render),
    },
  };
}

export const hasDiagnosticDetailSession = () =>
  sessions.getStore() !== undefined;

function supportsContextualRule(rule: string): boolean {
  return [
    "@typescript-eslint/require-await",
    "@typescript-eslint/no-unused-vars",
    "no-unused-vars",
    "react/no-unknown-property",
    "typescript/TS2305",
    "typescript/TS2875",
    "typescript/TS2307",
    "typescript/TS2304",
    "typescript/TS2339",
    "typescript/TS2551",
  ].includes(rule);
}
export function needsContextualDiagnosticDetails(
  set: CheckObservationSet,
): boolean {
  return set.targetObservations.some(
    (o) => supportsContextualRule(o.rule) && o.message.includes("[source]"),
  );
}
