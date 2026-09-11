import { describe, expect, it } from "vitest";
import { ResultAssembler } from "../../src/service/large-result.js";
import { ByteBudget } from "../../src/service/protocol.js";

describe("bounded result assembly", () => {
  it("keeps partial replies private and charged until completion or disconnect", () => {
    const budget = new ByteBudget(1024);
    const assembler = new ResultAssembler(budget);
    const received: unknown[] = [];
    const releases: Array<() => void> = [];
    const receive = (value: unknown, release: () => void) => {
      received.push(value);
      releases.push(release);
    };
    assembler.accept({ type: "result-start", bytes: 6 }, receive);
    assembler.accept(
      { type: "result-chunk", data: Buffer.from('"abc').toString("base64") },
      receive,
    );
    expect(received).toEqual([]);
    expect(budget.used).toBe(6);
    assembler.accept(
      { type: "result-chunk", data: Buffer.from('d"').toString("base64") },
      receive,
    );
    assembler.accept({ type: "result-end" }, receive);
    expect(received).toEqual(["abcd"]);
    expect(budget.used).toBe(6);
    releases[0]!();
    expect(budget.used).toBe(0);
    assembler.accept({ type: "result-start", bytes: 100 }, receive);
    assembler.close();
    assembler.close();
    expect(budget.used).toBe(0);
  });

  it("rejects excessive lengths before reserving memory", () => {
    const budget = new ByteBudget(64 * 1024 * 1024);
    const assembler = new ResultAssembler(budget);
    for (const bytes of [
      0,
      -1,
      1.5,
      129 * 1024 * 1024,
      Number.MAX_SAFE_INTEGER,
    ]) {
      expect(() =>
        assembler.accept({ type: "result-start", bytes }, () => {}),
      ).toThrow();
      expect(budget.used).toBe(0);
    }
  });

  it.each([
    [{ type: "result-end" }],
    [{ type: "result-start", bytes: 4 }, { type: "result-end" }],
    [
      { type: "result-start", bytes: 4 },
      { type: "result-start", bytes: 4 },
    ],
    [
      { type: "result-start", bytes: 1 },
      { type: "result-chunk", data: "eHg=" },
    ],
    [
      { type: "result-start", bytes: 4 },
      { type: "result-chunk", data: "@@@=" },
    ],
    [
      { type: "result-start", bytes: 4 },
      { type: "result-chunk", data: "" },
    ],
  ])(
    "rejects malformed/truncated transfers and releases their buffers on close: %j",
    (...frames) => {
      const budget = new ByteBudget(1024);
      const assembler = new ResultAssembler(budget);
      const received: unknown[] = [];
      expect(() => {
        for (const frame of frames)
          assembler.accept(frame, (v) => received.push(v));
      }).toThrow();
      assembler.close();
      expect(received).toEqual([]);
      expect(budget.used).toBe(0);
    },
  );

  it("keeps JSON depth validation when decoding assembled replies", () => {
    const budget = new ByteBudget(1024);
    const assembler = new ResultAssembler(budget);
    const bytes = Buffer.from("[".repeat(200) + "0" + "]".repeat(200));
    assembler.accept({ type: "result-start", bytes: bytes.length }, () => {});
    assembler.accept(
      { type: "result-chunk", data: bytes.toString("base64") },
      () => {},
    );
    expect(() => assembler.accept({ type: "result-end" }, () => {})).toThrow();
    expect(budget.used).toBe(0);
  });
});
