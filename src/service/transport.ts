import { chmod, lstat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { createServer, type Server, type Socket } from "node:net";
import type { ServiceState } from "./state.js";
import { AnalyzerCapacityError } from "../checks/runner/envelope.js";
import {
  MAX_RESULT_BYTES,
  RESULT_CHUNK_BYTES,
  RETAINED_RESULT_BYTES,
  ResultAssembler,
} from "./large-result.js";
import {
  AUTH_FRAME,
  ByteBudget,
  FrameDecoder,
  MAX_FRAME,
  ServiceUnavailableError,
  encodeFrame,
} from "./protocol.js";
export function serviceEndpoint(state: ServiceState, instance: string): string {
  return process.platform === "win32"
    ? `\\\\.\\pipe\\zedbee-${instance}`
    : join(state.directory, "ipc");
}
export class ServiceConnection {
  readonly decoder: FrameDecoder;
  private readonly writing = new Set<() => void>();
  private readonly results: ResultAssembler;
  private acceptResults = false;
  private sendingResults: Promise<void> = Promise.resolve();
  private readonly disconnected = new AbortController();
  constructor(
    readonly socket: Socket,
    input: ByteBudget,
    private readonly output: ByteBudget,
    receive: (value: unknown, release: () => void) => void,
    private readonly resultOutput = new ByteBudget(RETAINED_RESULT_BYTES),
  ) {
    this.results = new ResultAssembler(new ByteBudget(MAX_RESULT_BYTES));
    this.decoder = new FrameDecoder(input, AUTH_FRAME, (value, release) => {
      if (this.acceptResults && this.results.accept(value, receive)) release();
      else receive(value, release);
    });
    socket.on("data", (chunk) => {
      try {
        if (typeof chunk === "string") throw new ServiceUnavailableError();
        this.decoder.push(chunk);
      } catch {
        socket.destroy();
      }
    });
    socket.on("error", () => {});
    socket.once("close", () => {
      this.decoder.close();
      this.results.close();
      this.disconnected.abort();
      for (const release of this.writing) release();
      this.writing.clear();
    });
  }
  send(value: unknown): Promise<void> {
    try {
      const frame = encodeFrame(value, this.decoder.limit);
      const release = this.output.reserve(frame.length);
      this.writing.add(release);
      return this.write(frame).finally(() => {
        release();
        this.writing.delete(release);
      });
    } catch (error) {
      return Promise.reject(error);
    }
  }
  private write(frame: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket.write(frame, (error) => {
        if (error) reject(new ServiceUnavailableError());
        else resolve();
      });
    });
  }
  private async writeResultFrame(value: unknown): Promise<void> {
    const frame = encodeFrame(value);
    // Payload writes wait for room; control/error/ownership exchanges retain
    // a dedicated margin in the unchanged shared frame budget.
    const release = await this.output.acquire(
      frame.length,
      this.disconnected.signal,
      1024 * 1024,
    );
    try {
      await this.write(frame);
    } finally {
      release();
    }
  }
  sendResult(value: unknown): Promise<void> {
    try {
      const json = JSON.stringify(value);
      if (json === undefined) throw new ServiceUnavailableError();
      const length = Buffer.byteLength(json);
      if (length > MAX_RESULT_BYTES || this.decoder.limit !== MAX_FRAME)
        throw new AnalyzerCapacityError("request");
      // Reserve the entire reply before sending anything, including while queued.
      // Chunk writes are sequential: at most one small encoded chunk is in flight.
      const release = this.resultOutput.reserve(length);
      const send = this.sendingResults
        .then(async () => {
          if (length <= MAX_FRAME) {
            await this.writeResultFrame(value);
            return;
          }
          const body = Buffer.from(json);
          await this.writeResultFrame({ type: "result-start", bytes: length });
          for (let offset = 0; offset < length; offset += RESULT_CHUNK_BYTES) {
            await this.writeResultFrame({
              type: "result-chunk",
              data: body
                .subarray(offset, offset + RESULT_CHUNK_BYTES)
                .toString("base64"),
            });
          }
          await this.writeResultFrame({ type: "result-end" });
        })
        .finally(release);
      this.sendingResults = send.catch(() => {});
      return send;
    } catch (error) {
      return Promise.reject(error);
    }
  }
  authenticated(acceptResults = false): void {
    this.acceptResults = acceptResults;
    this.decoder.limit = MAX_FRAME;
  }
  destroy(): void {
    this.socket.destroy();
  }
}
export async function listenPrivate(
  state: ServiceState,
  instance: string,
  accept: (socket: Socket) => void,
): Promise<Server> {
  const endpoint = serviceEndpoint(state, instance);
  if (process.platform !== "win32") {
    if (Buffer.byteLength(endpoint) > 103) throw new ServiceUnavailableError();
    try {
      const prior = await lstat(endpoint);
      if (!prior.isSocket() || prior.uid !== process.getuid!())
        throw new ServiceUnavailableError();
      // Caller holds the permanent kernel lock. No live owner may bind this name.
      await unlink(endpoint);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  let restricted = false;
  const server = createServer({ pauseOnConnect: true }, (socket) => {
    if (!restricted) {
      socket.destroy();
      return;
    }
    accept(socket);
    socket.resume();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint, resolve);
  });
  try {
    if (process.platform === "win32")
      (await import("./windows-pipe.js")).restrictWindowsPipe(endpoint);
    else {
      await chmod(endpoint, 0o600);
      const stat = await lstat(endpoint);
      if (
        !stat.isSocket() ||
        stat.uid !== process.getuid!() ||
        (stat.mode & 0o777) !== 0o600
      )
        throw new ServiceUnavailableError();
    }
    // Dispatch already accepted connections while the gate is closed. The
    // publication secret has not been written; no earlier peer knows it.
    await new Promise<void>((resolve) => setImmediate(resolve));
    restricted = true;
    return server;
  } catch (error) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw error;
  }
}
