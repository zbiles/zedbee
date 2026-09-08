import { chmod, lstat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { createServer, type Server, type Socket } from "node:net";
import type { ServiceState } from "./state.js";
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
  constructor(
    readonly socket: Socket,
    input: ByteBudget,
    private readonly output: ByteBudget,
    receive: (value: unknown, release: () => void) => void,
  ) {
    this.decoder = new FrameDecoder(input, AUTH_FRAME, receive);
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
      for (const release of this.writing) release();
      this.writing.clear();
    });
  }
  send(value: unknown): Promise<void> {
    try {
      const frame = encodeFrame(value, this.decoder.limit);
      const release = this.output.reserve(frame.length);
      this.writing.add(release);
      return new Promise((resolve, reject) => {
        this.socket.write(frame, (error) => {
          release();
          this.writing.delete(release);
          if (error) reject(new ServiceUnavailableError());
          else resolve();
        });
      });
    } catch (error) {
      this.socket.destroy();
      return Promise.reject(error);
    }
  }
  authenticated(): void {
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
