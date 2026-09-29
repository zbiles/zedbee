import type { Stats } from "node:fs";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { telemetryEventSchema, type TelemetryEvent } from "./schema.js";
import type { TelemetryEnvironment } from "./policy.js";
const WEEK = 7 * 24 * 60 * 60 * 1000;
const stateSchema = z.strictObject({
  version: z.literal(1),
  enabled: z.boolean(),
  installation_id: z.string().uuid().optional(),
  notice_version: z.number().int().min(0).max(1),
  events: z.array(telemetryEventSchema).max(100),
});
export type TelemetryState = z.infer<typeof stateSchema>;
export function telemetryDirectory(env: TelemetryEnvironment): string {
  const root =
    env.XDG_STATE_HOME && isAbsolute(env.XDG_STATE_HOME)
      ? env.XDG_STATE_HOME
      : join(homedir(), ".local", "state");
  return join(root, "zedbee", "telemetry");
}
function owned(stat: Stats): void {
  if (
    process.platform !== "win32" &&
    (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)
  )
    throw new Error("Unsafe telemetry permissions");
}
function readPrivate(path: string, maximum: number): string | undefined {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    const stat = fstatSync(fd);
    owned(stat);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > maximum)
      throw new Error("Unsafe telemetry file");
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}
export class TelemetryStore {
  constructor(readonly directory: string) {}
  private checkDirectory(create = false): boolean {
    if (create) mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    try {
      const stat = lstatSync(this.directory);
      owned(stat);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error("Unsafe telemetry directory");
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
  read(): TelemetryState | undefined {
    if (!this.checkDirectory()) return undefined;
    const raw = readPrivate(join(this.directory, "state.json"), 300_000);
    return raw === undefined ? undefined : stateSchema.parse(JSON.parse(raw));
  }
  // No waiting on another CLI: optional telemetry skips busy state, rather than blocking a commit.
  lock(name = "state.lock"): () => void {
    this.checkDirectory(true);
    const path = join(this.directory, name);
    // Serialize reclamation too: two reclaimers must never unlink a fresh owner's lock.
    let recovery: number | undefined;
    const recoveryPath = `${path}.reclaim`;
    try {
      if (Date.now() - lstatSync(path).mtimeMs > 10_000) {
        recovery = openSync(recoveryPath, "wx", 0o600);
        const raw = readPrivate(path, 128);
        if (
          raw !== undefined &&
          Date.now() - lstatSync(path).mtimeMs > 10_000
        ) {
          const pid = Number(raw);
          if (Number.isSafeInteger(pid) && pid > 0) {
            try {
              process.kill(pid, 0);
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === "ESRCH")
                unlinkSync(path);
            }
          }
        }
      }
    } catch {
      /* Fail closed on unverifiable/busy recovery locks. */
    } finally {
      if (recovery !== undefined) {
        closeSync(recovery);
        try {
          unlinkSync(recoveryPath);
        } catch {}
      }
    }
    const fd = openSync(path, "wx", 0o600);
    try {
      writeFileSync(fd, String(process.pid));
    } catch (error) {
      closeSync(fd);
      try {
        unlinkSync(path);
      } catch {}
      throw error;
    }
    const identity = fstatSync(fd);
    closeSync(fd);
    return () => {
      try {
        const current = lstatSync(path);
        if (current.ino === identity.ino && current.dev === identity.dev)
          unlinkSync(path);
      } catch {}
    };
  }
  private update(change: (state: TelemetryState) => void): TelemetryState {
    const release = this.lock();
    let temporary: string | undefined;
    try {
      const state = this.read() ?? {
        version: 1,
        enabled: true,
        notice_version: 0,
        events: [],
      };
      change(state);
      stateSchema.parse(state);
      temporary = join(this.directory, `${randomUUID()}.tmp`);
      writeFileSync(temporary, JSON.stringify(state), {
        flag: "wx",
        mode: 0o600,
      });
      renameSync(temporary, join(this.directory, "state.json"));
      return state;
    } finally {
      if (temporary) {
        try {
          unlinkSync(temporary);
        } catch {}
      }
      release();
    }
  }
  initialize(notice: () => void): TelemetryState {
    return this.update((state) => {
      if (!state.enabled) return;
      if (state.notice_version !== 1) {
        notice();
        state.notice_version = 1;
      }
      state.installation_id ??= randomUUID();
    });
  }
  setEnabled(enabled: boolean): void {
    this.update((state) => {
      state.enabled = enabled;
      if (!enabled) state.events = [];
    });
  }
  enqueue(event: TelemetryEvent): void {
    telemetryEventSchema.parse(event);
    if (event.environment === "ci")
      throw new Error("CI events cannot be persisted");
    this.update((state) => {
      if (!state.enabled) return;
      state.events = [...state.events, event]
        .filter((e) => Date.parse(e.timestamp) >= Date.now() - WEEK)
        .slice(-100);
      while (Buffer.byteLength(JSON.stringify(state.events)) > 256 * 1024)
        state.events.shift();
    });
  }
  pending(): TelemetryEvent[] {
    const state = this.read();
    return state?.enabled
      ? state.events.filter((e) => Date.parse(e.timestamp) >= Date.now() - WEEK)
      : [];
  }
  acknowledge(ids: readonly string[]): void {
    const accepted = new Set(ids);
    this.update((state) => {
      state.events = state.events.filter((e) => !accepted.has(e.event_id));
    });
  }
}
