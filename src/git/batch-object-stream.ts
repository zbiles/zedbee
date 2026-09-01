import { GitCommandError } from "./errors.js";

const OBJECT_ID = /^(?:[\da-f]{40}|[\da-f]{64})$/u;
const BATCH_HEADER = /^([\da-f]{40}|[\da-f]{64}) blob (0|[1-9]\d*)$/u;
const MAX_BATCH_HEADER_BYTES = 160;

function protocolFailure(): never {
  throw new GitCommandError(
    "GIT_COMMAND_FAILED",
    "Git returned an invalid batch object response.",
  );
}

class ByteReader {
  private readonly iterator: AsyncIterator<Uint8Array>;
  private current: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private offset = 0;
  private ended = false;

  constructor(source: AsyncIterable<Uint8Array>) {
    this.iterator = source[Symbol.asyncIterator]();
  }

  private async ensureBytes(): Promise<boolean> {
    while (this.offset >= this.current.length) {
      if (this.ended) return false;
      const next = await this.iterator.next();
      if (next.done === true) {
        this.ended = true;
        this.current = Buffer.alloc(0);
        this.offset = 0;
        return false;
      }
      this.current = Buffer.isBuffer(next.value)
        ? next.value
        : Buffer.from(next.value);
      this.offset = 0;
    }
    return true;
  }

  async line(): Promise<Buffer> {
    const pieces: Buffer[] = [];
    let length = 0;
    while (await this.ensureBytes()) {
      const newline = this.current.indexOf(0x0a, this.offset);
      const end = newline === -1 ? this.current.length : newline;
      const piece = this.current.subarray(this.offset, end);
      pieces.push(piece);
      length += piece.length;
      if (length > MAX_BATCH_HEADER_BYTES) return protocolFailure();
      this.offset = newline === -1 ? end : newline + 1;
      if (newline !== -1) return Buffer.concat(pieces, length);
    }
    return protocolFailure();
  }

  exact(size: number): {
    chunks(): AsyncIterable<Buffer>;
    done(): boolean;
  } {
    let remaining = size;
    let consumed = size === 0;
    let started = false;
    const reader = this;
    return {
      async *chunks() {
        if (started) return protocolFailure();
        started = true;
        while (remaining > 0) {
          if (!(await reader.ensureBytes())) return protocolFailure();
          const length = Math.min(
            remaining,
            reader.current.length - reader.offset,
          );
          const chunk = reader.current.subarray(
            reader.offset,
            reader.offset + length,
          );
          reader.offset += length;
          remaining -= length;
          yield chunk;
        }
        consumed = true;
      },
      done() {
        return consumed;
      },
    };
  }

  async delimiter(): Promise<void> {
    if (!(await this.ensureBytes()) || this.current[this.offset] !== 0x0a) {
      return protocolFailure();
    }
    this.offset += 1;
  }

  async end(): Promise<void> {
    if (await this.ensureBytes()) return protocolFailure();
  }
}

export interface GitBlobStream {
  readonly objectId: string;
  readonly size: number;
  readonly chunks: AsyncIterable<Buffer>;
}

export type GitBlobVisitor = (blob: GitBlobStream) => Promise<void>;

export async function consumeGitBatchBlobOutput(
  source: AsyncIterable<Uint8Array>,
  expectedObjectIds: readonly string[],
  visit: GitBlobVisitor,
): Promise<void> {
  if (expectedObjectIds.some((objectId) => !OBJECT_ID.test(objectId))) {
    return protocolFailure();
  }
  const reader = new ByteReader(source);
  for (const expectedObjectId of expectedObjectIds) {
    const header = (await reader.line()).toString("latin1");
    const match = BATCH_HEADER.exec(header);
    const size = match === null ? Number.NaN : Number(match[2]);
    if (
      match === null ||
      match[1] !== expectedObjectId ||
      !Number.isSafeInteger(size) ||
      size < 0
    ) {
      return protocolFailure();
    }
    const body = reader.exact(size);
    await visit({ objectId: expectedObjectId, size, chunks: body.chunks() });
    if (!body.done()) return protocolFailure();
    await reader.delimiter();
  }
  await reader.end();
}
