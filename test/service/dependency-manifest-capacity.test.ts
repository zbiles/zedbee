import { expect, it } from "vitest";
import { sanitizeDependencyInputManifest } from "../../src/cache/dependency-inputs.js";
import {
  ByteBudget,
  encodeFrame,
  MAX_FRAME,
} from "../../src/service/protocol.js";
import {
  MAX_RESULT_BYTES,
  RESULT_CHUNK_BYTES,
  ResultAssembler,
} from "../../src/service/large-result.js";

it("transports a supported dependency witness beyond one frame without relaxing result budgets", () => {
  const prefix = Array.from(
    { length: 4 },
    (_, index) => `${index}${"x".repeat(143)}`,
  ).join("/");
  const manifest = sanitizeDependencyInputManifest({
    version: 1,
    roots: "a".repeat(64),
    probes: Array.from({ length: 28_000 }, (_, index) => ({
      kind: "missing",
      path: `packages:${prefix}/p${index}`,
    })),
  });
  const bytes = Buffer.from(JSON.stringify(manifest));
  expect(bytes.length).toBeGreaterThan(MAX_FRAME);
  expect(bytes.length).toBeLessThan(MAX_RESULT_BYTES);
  expect(() => encodeFrame(manifest)).toThrow();
  const budget = new ByteBudget(MAX_RESULT_BYTES);
  const assembler = new ResultAssembler(budget);
  let received: unknown;
  let release: (() => void) | undefined;
  const accept = (value: unknown, done: () => void) => {
    received = value;
    release = done;
  };
  assembler.accept({ type: "result-start", bytes: bytes.length }, accept);
  for (let offset = 0; offset < bytes.length; offset += RESULT_CHUNK_BYTES) {
    assembler.accept(
      {
        type: "result-chunk",
        data: bytes
          .subarray(offset, offset + RESULT_CHUNK_BYTES)
          .toString("base64"),
      },
      accept,
    );
  }
  expect(received).toBeUndefined();
  expect(budget.used).toBe(bytes.length);
  assembler.accept({ type: "result-end" }, accept);
  expect(sanitizeDependencyInputManifest(received).probes).toHaveLength(28_000);
  release!();
  expect(budget.used).toBe(0);
  assembler.close();
});
