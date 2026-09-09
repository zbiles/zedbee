import {
  AnalyzerJobError,
  analyzerDiagnostic,
  ANALYZER_FAILURE_CATEGORIES,
  type AnalyzerFailureCategory,
} from "../diagnostics.js";
import {
  CheckIncompleteError,
  type CheckIncompleteErrorOptions,
} from "../incomplete-error.js";
import {
  validateAnalyzerResult,
  type AnalyzerRequest,
  type AnalyzerResult,
} from "./protocol.js";
import { types } from "node:util";

const arrayBufferBytes = Object.getOwnPropertyDescriptor(
  ArrayBuffer.prototype,
  "byteLength",
)!.get!;
const typedArrayBuffer = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  "buffer",
)!.get!;
const dataViewBuffer = Object.getOwnPropertyDescriptor(
  DataView.prototype,
  "buffer",
)!.get!;

export interface JobIdentity {
  readonly sessionId: string;
  readonly jobId: string;
}
export class AnalyzerCapacityError extends RangeError {
  readonly code = "ANALYZER_CAPACITY";
  constructor(readonly scope: "session" | "job" | "request") {
    super(`Analyzer ${scope} capacity exceeded.`);
    this.name = "AnalyzerCapacityError";
  }
}
/** Bound accepted local payloads before cloning. Service frame limits precede this. */
export function analyzerRequestRetentionBytes(value: unknown): number {
  let bytes = 0,
    fields = 0;
  const seen = new Set<object>();
  const pending: unknown[] = [value];
  while (pending.length) {
    const item = pending.pop();
    if (typeof item === "string") bytes += item.length * 2;
    else if (typeof item === "object" && item !== null && !seen.has(item)) {
      // Proxies can execute traps even during descriptor/prototype inspection.
      // No executable request state may run between accounting and cloning.
      if (types.isProxy(item))
        throw new TypeError("Invalid analyzer request object.");
      seen.add(item);
      bytes += 128;
      if (ArrayBuffer.isView(item))
        // Structured cloning a view copies its entire backing buffer. Intrinsic
        // getters avoid an overridden .buffer or .byteLength executing user code.
        bytes += arrayBufferBytes.call(
          (types.isDataView(item) ? dataViewBuffer : typedArrayBuffer).call(
            item,
          ),
        );
      else if (types.isArrayBuffer(item)) bytes += arrayBufferBytes.call(item);
      else {
        const prototype = Object.getPrototypeOf(item);
        if (
          prototype !== null &&
          prototype !==
            (Array.isArray(item) ? Array.prototype : Object.prototype)
        )
          throw new TypeError("Invalid analyzer request object.");
        for (const key in item)
          if (Object.hasOwn(item, key)) {
            bytes += 64 + key.length * 2;
            if (++fields > 100_000 || bytes > 64 * 1024 * 1024)
              throw new AnalyzerCapacityError("request");
            const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
            if (!("value" in descriptor))
              throw new TypeError("Invalid analyzer request accessor.");
            pending.push(descriptor.value);
          }
      }
    } else bytes += 8;
    if (bytes > 64 * 1024 * 1024) throw new AnalyzerCapacityError("request");
  }
  return bytes;
}
export function exactFields(
  value: unknown,
  fields: readonly string[],
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).every((key) => fields.includes(key))
  );
}
export function matchingIdentity(
  value: unknown,
  identity: JobIdentity,
  type: string,
  extra: readonly string[] = [],
): value is Record<string, unknown> {
  if (!exactFields(value, ["version", "type", "sessionId", "jobId", ...extra]))
    return false;
  return (
    value.version === 1 &&
    value.type === type &&
    value.sessionId === identity.sessionId &&
    value.jobId === identity.jobId
  );
}
export function jobFailure(
  request: AnalyzerRequest,
  category: AnalyzerFailureCategory,
  exitCode?: number | null,
  signal?: string | null,
): AnalyzerJobError {
  return new AnalyzerJobError(
    analyzerDiagnostic(
      request.checkId,
      request.operation,
      category,
      exitCode,
      signal,
    ),
  );
}
/** Validate the entire provisional payload before accepting reset/ready. */
export function decodeWorkerResponse<R extends AnalyzerRequest>(
  request: R,
  value: unknown,
): { result: AnalyzerResult<R> } | { error: Error } {
  if (
    !exactFields(value, [
      "version",
      "ok",
      "result",
      "category",
      "exitCode",
      "signal",
      "incomplete",
    ]) ||
    value.version !== 1 ||
    typeof value.ok !== "boolean"
  )
    throw jobFailure(request, "invalid-response");
  if (value.ok) {
    if (!exactFields(value, ["version", "ok", "result"]))
      throw jobFailure(request, "invalid-response");
    return { result: validateAnalyzerResult(request, value.result) };
  }
  if (
    "result" in value ||
    !ANALYZER_FAILURE_CATEGORIES.includes(
      value.category as AnalyzerFailureCategory,
    )
  )
    throw jobFailure(request, "invalid-response");
  const incomplete = value.incomplete as
    CheckIncompleteErrorOptions | undefined;
  if (
    incomplete !== undefined &&
    !exactFields(incomplete, [
      "code",
      "message",
      "remediation",
      "path",
      "paths",
      "snapshot",
      "projectPaths",
      "disposition",
    ])
  )
    throw jobFailure(request, "invalid-response");
  const diagnostic = {
    ...analyzerDiagnostic(
      request.checkId,
      request.operation,
      value.category as AnalyzerFailureCategory,
      value.exitCode as number | undefined,
      value.signal as string | undefined,
    ),
    ...(incomplete?.snapshot === undefined
      ? {}
      : {
          snapshot:
            incomplete.snapshot === "last-commit"
              ? ("baseline" as const)
              : ("target" as const),
        }),
  };
  if (value.signal !== undefined && diagnostic.signal !== value.signal)
    throw jobFailure(request, "invalid-response");
  return {
    error:
      incomplete === undefined
        ? new AnalyzerJobError(diagnostic)
        : new CheckIncompleteError({ ...incomplete, diagnostic }),
  };
}
