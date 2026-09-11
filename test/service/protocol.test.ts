import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import {
  ByteBudget,
  FrameDecoder,
  encodeFrame,
  proof,
  verifyProof,
} from "../../src/service/protocol.js";

describe("private service framing and authentication", () => {
  it("waits for payload space while leaving room for control traffic", async () => {
    const budget = new ByteBudget(100);
    const releasePayload = budget.reserve(90);
    let acquired = false;
    const waiting = budget
      .acquire(5, new AbortController().signal, 10)
      .then((release) => {
        acquired = true;
        return release;
      });
    await Promise.resolve();
    expect(acquired).toBe(false);
    const releaseControl = budget.reserve(10);
    expect(budget.used).toBe(100);
    releasePayload();
    const release = await waiting;
    expect(budget.used).toBe(15);
    release();
    releaseControl();
    expect(budget.used).toBe(0);
  });
  it("cancels waiting payload writes on disconnect without taking a later reservation", async () => {
    const budget = new ByteBudget(100);
    const release = budget.reserve(100);
    const controller = new AbortController();
    const waiting = budget.acquire(20, controller.signal);
    controller.abort();
    await expect(waiting).rejects.toThrow();
    release();
    expect(budget.used).toBe(0);
    await expect(
      budget.acquire(101, new AbortController().signal),
    ).rejects.toThrow();
    await expect(budget.acquire(20, controller.signal)).rejects.toThrow();
    expect(budget.used).toBe(0);
  });
  it("reconstructs fragmented frames without accepting a partial message", () => {
    const messages: unknown[] = [];
    const budget = new ByteBudget(1024);
    const decoder = new FrameDecoder(budget, 512, (value, release) => {
      messages.push(value);
      release();
    });
    const wire = encodeFrame({ operation: "status" }, 512);
    for (const byte of wire.subarray(0, -1)) decoder.push(Buffer.from([byte]));
    expect(messages).toEqual([]);
    decoder.push(wire.subarray(-1));
    expect(messages).toEqual([{ operation: "status" }]);
    expect(budget.used).toBe(0);
  });
  it("rejects the oversized length header before reserving or accepting body bytes", () => {
    const budget = new ByteBudget(1024);
    const decoder = new FrameDecoder(budget, 512, () => {
      throw new Error("must not decode");
    });
    const header = Buffer.alloc(4);
    header.writeUInt32BE(513);
    expect(() => decoder.push(header)).toThrow();
    expect(budget.used).toBe(0);
  });
  it("shares admission across decoders and retains the charge until the consumer releases", () => {
    const budget = new ByteBudget(30);
    const releases: Array<() => void> = [];
    const decoder = () =>
      new FrameDecoder(budget, 30, (_value, release) => releases.push(release));
    const first = decoder(),
      second = decoder();
    first.push(encodeFrame("123456789012345678", 30));
    expect(budget.used).toBe(20);
    expect(() => second.push(encodeFrame("1234567890", 30))).toThrow();
    releases[0]!();
    releases[0]!();
    expect(budget.used).toBe(0);
    second.close();
    first.close();
  });
  it("releases partial input on disconnect and rejects malformed or deeply nested JSON", () => {
    const budget = new ByteBudget(4096);
    const first = new FrameDecoder(budget, 4096, () => {});
    const header = Buffer.alloc(4);
    header.writeUInt32BE(100);
    first.push(header);
    expect(budget.used).toBe(100);
    first.close();
    expect(budget.used).toBe(0);
    for (const json of ["{", "[".repeat(200) + "0" + "]".repeat(200)]) {
      const decoder = new FrameDecoder(budget, 4096, () => {
        throw new Error("unexpected message");
      });
      const bytes = Buffer.from(json);
      const length = Buffer.alloc(4);
      length.writeUInt32BE(bytes.length);
      expect(() => decoder.push(Buffer.concat([length, bytes]))).toThrow();
      decoder.close();
      expect(budget.used).toBe(0);
    }
  });
  it("binds mutual proofs to role, identity, and both fresh challenges without sending the secret", () => {
    const secret = randomBytes(32).toString("hex");
    const a = "a".repeat(64),
      b = "b".repeat(64),
      identity = "c".repeat(64);
    const valid = proof(secret, "server", identity, a, b);
    expect(valid).not.toContain(secret);
    expect(verifyProof(valid, secret, "server", identity, a, b)).toBe(true);
    for (const candidate of ["", "garbage", valid.slice(1), "0".repeat(64)])
      expect(verifyProof(candidate, secret, "server", identity, a, b)).toBe(
        false,
      );
    expect(verifyProof(valid, secret, "client", identity, a, b)).toBe(false);
    expect(verifyProof(valid, secret, "server", "d".repeat(64), a, b)).toBe(
      false,
    );
    expect(verifyProof(valid, secret, "server", identity, b, a)).toBe(false);
    expect(verifyProof(valid, "e".repeat(64), "server", identity, a, b)).toBe(
      false,
    );
  });
});
