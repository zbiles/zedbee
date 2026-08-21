import { describe, expect, it } from "vitest";
import {
  fingerprintObservation,
  normalizeObservation,
} from "../../src/attribution/fingerprint.js";
import type { Observation } from "../../src/core/types.js";
import { createObservation } from "../helpers/scan-report.js";

const observation = createObservation();

describe("fingerprintObservation", () => {
  it("keeps identity stable when engine prose changes", () => {
    expect(
      fingerprintObservation({
        ...observation,
        message: "A reworded engine message",
        remediation: "Different remediation prose",
      }),
    ).toBe(fingerprintObservation(observation));
  });

  it("uses a deterministic SHA-256 digest of canonical identity fields", () => {
    expect(fingerprintObservation(observation)).toBe(
      "7f83aa76d4f81cd96b0546f6a99ac53956adf3a022a9a2520f19682caedd3ddd",
    );
  });

  it("excludes metric values, limits, and untrusted runtime prose from identity", () => {
    const metric = createObservation({
      metric: { name: "cyclomatic-complexity", value: 25, limit: 20 },
    });
    const contaminated = {
      ...metric,
      message: "engine prose containing top-secret-token",
      remediation: "source text: const password = 'top-secret-token'",
      metric: { name: "cyclomatic-complexity", value: 99, limit: 5 },
      sourceContents: "const password = 'top-secret-token'",
      temporaryRoot: "/private/tmp/zedbee-secret-snapshot",
      secretValue: "top-secret-token",
      engineProse: "machine-specific diagnostic prose",
    } as Observation & Record<string, unknown>;

    const original = fingerprintObservation(metric);
    const changed = fingerprintObservation(contaminated);
    expect(changed).toBe(original);
    expect(changed).toMatch(/^[a-f0-9]{64}$/);
    expect(changed).not.toContain("top-secret-token");
    expect(changed).not.toContain("/private/tmp");
    expect(changed).not.toContain("engine prose");
  });

  it.each([
    ["check", createObservation({ check: "types" })],
    ["rule", createObservation({ rule: "TS2322" })],
    ["canonical identity", createObservation({ identity: "diagnostic:other" })],
    [
      "location",
      createObservation({
        location: { file: "src/other.ts", startLine: 4, startColumn: 3 },
      }),
    ],
    [
      "entity",
      createObservation({
        location: undefined,
        entity: { kind: "function", name: "parseOrder", file: "src/value.ts" },
      }),
    ],
    [
      "metric name",
      createObservation({
        metric: { name: "readability-complexity", value: 25, limit: 20 },
      }),
    ],
  ] satisfies ReadonlyArray<readonly [string, Observation]>)(
    "changes when %s changes",
    (_field, changed) => {
      expect(fingerprintObservation(changed)).not.toBe(
        fingerprintObservation(observation),
      );
    },
  );

  it("normalizes safe separators and dot segments before hashing", () => {
    const windows = createObservation({
      location: { file: "src\\feature\\.\\value.ts", startLine: 4 },
    });
    const portable = createObservation({
      location: { file: "src/feature/value.ts", startLine: 4 },
    });

    expect(fingerprintObservation(windows)).toBe(
      fingerprintObservation(portable),
    );
  });

  it.each([
    "/private/tmp/snapshot/src/value.ts",
    "C:\\temp\\snapshot\\src\\value.ts",
    "C:secret.ts",
    "\\\\server\\share\\src\\value.ts",
    "../src/value.ts",
    "src/../../value.ts",
    "src/\u0001secret.ts",
    "src/\u007fsecret.ts",
    "src/\u0085secret.ts",
    "src/\u202esecret.ts",
    "src/\u2066secret.ts",
    "src/line\u2028separator.ts",
    "src/paragraph\u2029separator.ts",
    `src/${"x".repeat(256)}.ts`,
    `src/${"x".repeat(4096)}`,
    "",
  ])("rejects unsafe or machine-specific location path %j", (file) => {
    expect(() =>
      fingerprintObservation(createObservation({ location: { file } })),
    ).toThrow(/repository-relative path/i);
  });

  it("preserves valid Unicode repository paths within the documented bounds", () => {
    expect(
      normalizeObservation(
        createObservation({ location: { file: "src/日本語/naïve.ts" } }),
      ).location?.file,
    ).toBe("src/日本語/naïve.ts");
  });

  it("accepts bounded internal identities longer than terminal labels", () => {
    const identity = `dependency-edge:${"nested/".repeat(1_300)}leaf`;
    const comparisonIdentity = `comparison:${"branch/".repeat(50)}leaf`;

    expect(
      normalizeObservation(createObservation({ identity, comparisonIdentity })),
    ).toMatchObject({ identity, comparisonIdentity });
    expect(() =>
      normalizeObservation(
        createObservation({ identity: `function:${"x".repeat(128 * 1024 + 1)}` }),
      ),
    ).toThrow(/canonical identity/i);
  });

  it("rejects unsafe entity paths before hashing", () => {
    expect(() =>
      fingerprintObservation(
        createObservation({
          location: undefined,
          entity: { kind: "function", name: "run", file: "../../outside.ts" },
        }),
      ),
    ).toThrow(/repository-relative path/i);
  });

  it("snapshots every documented field once without invoking unknown getters", () => {
    const reads = new Map<string, number>();
    const once =
      <T>(name: string, first: T, later: T = first) =>
      () => {
        const count = (reads.get(name) ?? 0) + 1;
        reads.set(name, count);
        return count === 1 ? first : later;
      };
    const unknown = () => {
      throw new Error("unknown getter must not run");
    };
    const location = Object.defineProperties(
      {},
      {
        file: {
          enumerable: true,
          get: once("location.file", "src/value.ts", "src/changed.ts"),
        },
        startLine: { enumerable: true, get: once("location.startLine", 4, 99) },
        startColumn: {
          enumerable: true,
          get: once("location.startColumn", 3, 99),
        },
        endLine: { enumerable: true, get: once("location.endLine", 4, 99) },
        endColumn: {
          enumerable: true,
          get: once("location.endColumn", 12, 99),
        },
        sourceContents: { enumerable: true, get: unknown },
      },
    );
    const entity = Object.defineProperties(
      {},
      {
        kind: {
          enumerable: true,
          get: once("entity.kind", "function", "class"),
        },
        name: {
          enumerable: true,
          get: once("entity.name", "parse", "changed"),
        },
        file: {
          enumerable: true,
          get: once("entity.file", "src/value.ts", "src/changed.ts"),
        },
        sourceContents: { enumerable: true, get: unknown },
      },
    );
    const metric = Object.defineProperties(
      {},
      {
        name: {
          enumerable: true,
          get: once("metric.name", "complexity", "changed"),
        },
        value: { enumerable: true, get: once("metric.value", 12, 999) },
        limit: { enumerable: true, get: once("metric.limit", 10, 999) },
        engineProse: { enumerable: true, get: unknown },
      },
    );
    const untrusted = Object.defineProperties(
      {},
      {
        check: { enumerable: true, get: once("check", "lint", "types") },
        rule: {
          enumerable: true,
          get: once("rule", "no-unsafe-call", "changed"),
        },
        identity: {
          enumerable: true,
          get: once("identity", "diagnostic:no-unsafe-call", "changed"),
        },
        severity: {
          enumerable: true,
          get: once("severity", "error", "warning"),
        },
        message: {
          enumerable: true,
          get: once("message", "Unsafe call", "Changed message"),
        },
        location: {
          enumerable: true,
          get: once("location", location, undefined),
        },
        entity: { enumerable: true, get: once("entity", entity, undefined) },
        metric: { enumerable: true, get: once("metric", metric, undefined) },
        remediation: {
          enumerable: true,
          get: once("remediation", "Use a typed value.", undefined),
        },
        sourceContents: { enumerable: true, get: unknown },
      },
    ) as Observation;

    const snapshot = normalizeObservation(untrusted);

    expect(snapshot).toEqual({
      check: "lint",
      rule: "no-unsafe-call",
      identity: "diagnostic:no-unsafe-call",
      severity: "error",
      message: "Unsafe call",
      location: {
        file: "src/value.ts",
        startLine: 4,
        startColumn: 3,
        endLine: 4,
        endColumn: 12,
      },
      entity: { kind: "function", name: "parse", file: "src/value.ts" },
      metric: { name: "complexity", value: 12, limit: 10 },
      remediation: "Use a typed value.",
    });
    expect([...reads.values()]).toHaveLength(20);
    expect([...reads.values()].every((count) => count === 1)).toBe(true);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.location)).toBe(true);
    expect(Object.isFrozen(snapshot.entity)).toBe(true);
    expect(Object.isFrozen(snapshot.metric)).toBe(true);
  });

  it.each([
    ["check", { check: " lint" }],
    ["rule", { rule: "" }],
    ["identity", { identity: "diagnostic:\u0001secret" }],
    ["severity", { severity: "fatal" }],
    ["message", { message: 7 }],
    ["remediation", { remediation: 7 }],
    ["metric value", { metric: { name: "complexity", value: Number.NaN } }],
    [
      "metric limit",
      {
        metric: {
          name: "complexity",
          value: 2,
          limit: Number.POSITIVE_INFINITY,
        },
      },
    ],
    [
      "entity kind",
      {
        location: undefined,
        entity: { kind: " ", name: "parse", file: "src/value.ts" },
      },
    ],
  ])("fails closed on invalid adapter %s data", (_field, override) => {
    expect(() =>
      normalizeObservation(createObservation(override as never)),
    ).toThrow(/Expected/);
  });

  it("fails closed when a documented adapter getter throws", () => {
    const untrusted = Object.defineProperty({ ...observation }, "message", {
      get() {
        throw new Error("adapter getter failed");
      },
    }) as Observation;

    expect(() => normalizeObservation(untrusted)).toThrow(
      "adapter getter failed",
    );
  });
});
