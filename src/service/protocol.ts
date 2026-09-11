import { createHmac, timingSafeEqual } from "node:crypto";
import { AnalyzerCapacityError } from "../checks/runner/envelope.js";

export const MAX_FRAME = 16 * 1024 * 1024;
export const AUTH_FRAME = 4096;
export const GLOBAL_BYTES = 64 * 1024 * 1024;
export const HEX = /^[a-f0-9]{64}$/u;
export class ServiceUnavailableError extends Error {
  readonly code = "ANALYZER_SERVICE_UNAVAILABLE";
  constructor() {
    super("The private analyzer service is unavailable.");
  }
}
export class ByteBudget {
  used = 0;
  private readonly waiters = new Set<() => void>();
  constructor(readonly limit: number) {}
  reserve(bytes: number): () => void {
    if (
      !Number.isSafeInteger(bytes) ||
      bytes < 0 ||
      this.used + bytes > this.limit
    )
      throw new AnalyzerCapacityError("request");
    this.used += bytes;
    let held = true;
    return () => {
      if (held) {
        held = false;
        this.used -= bytes;
        for (const waiter of [...this.waiters]) waiter();
      }
    };
  }
  acquire(
    bytes: number,
    signal: AbortSignal,
    headroom = 0,
  ): Promise<() => void> {
    if (
      !Number.isSafeInteger(bytes) ||
      bytes < 0 ||
      bytes > this.limit - headroom
    )
      return Promise.reject(new AnalyzerCapacityError("request"));
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        this.waiters.delete(attempt);
        signal.removeEventListener("abort", abort);
      };
      const abort = () => {
        cleanup();
        reject(new ServiceUnavailableError());
      };
      const attempt = () => {
        if (signal.aborted) {
          abort();
          return;
        }
        if (this.used + bytes > this.limit - headroom) return;
        cleanup();
        resolve(this.reserve(bytes));
      };
      this.waiters.add(attempt);
      signal.addEventListener("abort", abort, { once: true });
      attempt();
    });
  }
}
export class FrameDecoder {
  private header = Buffer.alloc(4);
  private headerBytes = 0;
  private body: Buffer | undefined;
  private bodyBytes = 0;
  private release: (() => void) | undefined;
  private closed = false;
  constructor(
    private readonly budget: ByteBudget,
    public limit: number,
    private readonly receive: (value: unknown, release: () => void) => void,
  ) {}
  push(chunk: Buffer): void {
    if (this.closed) throw new ServiceUnavailableError();
    let offset = 0;
    try {
      while (offset < chunk.length) {
        if (!this.body) {
          const count = Math.min(4 - this.headerBytes, chunk.length - offset);
          chunk.copy(this.header, this.headerBytes, offset, offset + count);
          this.headerBytes += count;
          offset += count;
          if (this.headerBytes !== 4) continue;
          const length = this.header.readUInt32BE();
          if (!length || length > this.limit)
            throw new AnalyzerCapacityError("request");
          this.release = this.budget.reserve(length);
          this.body = Buffer.allocUnsafe(length);
        }
        const count = Math.min(
          this.body.length - this.bodyBytes,
          chunk.length - offset,
        );
        chunk.copy(this.body, this.bodyBytes, offset, offset + count);
        this.bodyBytes += count;
        offset += count;
        if (this.bodyBytes !== this.body.length) continue;
        const body = this.body,
          release = this.release!;
        this.body = undefined;
        this.release = undefined;
        this.bodyBytes = 0;
        this.headerBytes = 0;
        try {
          this.receive(decodeJson(body), release);
        } catch (error) {
          release();
          throw error;
        }
      }
    } catch (error) {
      this.close();
      throw error;
    }
  }
  close(): void {
    this.closed = true;
    this.release?.();
    this.release = undefined;
    this.body = undefined;
    this.bodyBytes = 0;
    this.headerBytes = 0;
  }
}
export function decodeJson(bytes: Buffer): unknown {
  // Bound parser nesting before JSON allocation; strings and escapes are lexical.
  let depth = 0,
    quoted = false,
    escaped = false;
  for (const byte of bytes) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (byte === 92) escaped = true;
      else if (byte === 34) quoted = false;
    } else if (byte === 34) quoted = true;
    else if (byte === 123 || byte === 91) {
      if (++depth > 128) throw new ServiceUnavailableError();
    } else if (byte === 125 || byte === 93) depth--;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}
export function encodeFrame(value: unknown, limit = MAX_FRAME): Buffer {
  const json = JSON.stringify(value);
  if (json === undefined) throw new ServiceUnavailableError();
  const length = Buffer.byteLength(json);
  if (!length || length > limit) throw new AnalyzerCapacityError("request");
  const frame = Buffer.allocUnsafe(length + 4);
  frame.writeUInt32BE(length);
  frame.write(json, 4);
  return frame;
}
export function proof(
  secret: string,
  role: string,
  identity: string,
  clientNonce: string,
  serverNonce: string,
): string {
  return createHmac("sha256", Buffer.from(secret, "hex"))
    .update(
      JSON.stringify([
        "zedbee-service-v1",
        role,
        identity,
        clientNonce,
        serverNonce,
      ]),
    )
    .digest("hex");
}
export function verifyProof(
  value: unknown,
  secret: string,
  role: string,
  identity: string,
  clientNonce: string,
  serverNonce: string,
): boolean {
  return (
    typeof value === "string" &&
    HEX.test(value) &&
    timingSafeEqual(
      Buffer.from(value, "hex"),
      Buffer.from(
        proof(secret, role, identity, clientNonce, serverNonce),
        "hex",
      ),
    )
  );
}
