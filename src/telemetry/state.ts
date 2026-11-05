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
import { createHash, randomUUID } from "node:crypto";
import { openSynchronousKernelFileLease } from "../core/kernel-lease.js";
import { openWindowsStateLease } from "../service/windows-pipe.js";
import { z } from "zod";
import {
  telemetryV1EventSchema as telemetryEventSchema,
  type TelemetryV1Event as TelemetryEvent,
} from "./schema.js";
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
const persistedSchema = z.strictObject({
  version: z.literal(2),
  state: stateSchema,
  acknowledged_legacy_optout: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .optional(),
});
type PersistedState = z.infer<typeof persistedSchema>;
function unavailable(): Error {
  return Object.assign(
    new Error(
      "Telemetry state is busy or unavailable; retry or set ZEDBEE_TELEMETRY_DISABLED=1",
    ),
    { code: "EBUSY" },
  );
}
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
function readPrivate(
  path: string,
  maximum: number,
): { raw: string; fingerprint: string } | undefined {
  let fd: number;
  try {
    fd = openSync(
      path,
      constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    const stat = fstatSync(fd);
    owned(stat);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > maximum)
      throw new Error("Unsafe telemetry file");
    const raw = readFileSync(fd, "utf8");
    const after = fstatSync(fd);
    const current = lstatSync(path);
    if (
      after.dev !== stat.dev ||
      after.ino !== stat.ino ||
      after.size !== stat.size ||
      after.mtimeMs !== stat.mtimeMs ||
      after.ctimeMs !== stat.ctimeMs ||
      current.dev !== stat.dev ||
      current.ino !== stat.ino
    )
      throw unavailable();
    return {
      raw,
      fingerprint: createHash("sha256")
        .update(
          JSON.stringify([
            stat.dev,
            stat.ino,
            stat.size,
            stat.mtimeMs,
            stat.ctimeMs,
            raw,
          ]),
        )
        .digest("hex"),
    };
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
  private snapshot(): {
    persisted: PersistedState | undefined;
    legacyFingerprint: string | undefined;
  } {
    if (!this.checkDirectory())
      return { persisted: undefined, legacyFingerprint: undefined };
    // Older wx/PID writers never touch this protocol's state, lease or outbox.
    // Their preference is read-only input; their recovery markers are never trusted.
    const legacyFile = readPrivate(join(this.directory, "state.json"), 300_000);
    const legacy =
      legacyFile === undefined
        ? undefined
        : stateSchema.parse(JSON.parse(legacyFile.raw));
    const current = readPrivate(join(this.directory, "state-v2.json"), 301_000);
    let persisted =
      current === undefined
        ? undefined
        : persistedSchema.parse(JSON.parse(current.raw));
    if (!persisted && legacy) {
      // Do not duplicate the old sender's outbox. Preserve its installation identity.
      persisted = { version: 2, state: { ...legacy, events: [] } };
    }
    if (
      persisted &&
      legacy?.enabled === false &&
      persisted.acknowledged_legacy_optout !== legacyFile?.fingerprint
    ) {
      persisted.state.enabled = false;
      persisted.state.events = [];
    }
    return {
      persisted,
      legacyFingerprint:
        legacy?.enabled === false ? legacyFile?.fingerprint : undefined,
    };
  }
  read(): TelemetryState | undefined {
    return this.snapshot().persisted?.state;
  }
  // Kernel ownership expires on process death. No retry, PID reclamation or unlink.
  lock(name: "state.lock" | "sender.lock" = "state.lock"): () => void {
    this.checkDirectory(true);
    const path = join(
      this.directory,
      name === "state.lock" ? "state-v2.lease" : "sender-v2.lease",
    );
    let lease;
    if (process.platform === "win32") {
      lease = openWindowsStateLease(path);
    } else {
      const fd = openSync(
        path,
        constants.O_CREAT |
          constants.O_RDWR |
          constants.O_NONBLOCK |
          (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      try {
        const stat = fstatSync(fd);
        owned(stat);
        if (!stat.isFile() || stat.nlink !== 1 || stat.size !== 0)
          throw new Error("Unsafe telemetry lease");
        const current = lstatSync(path);
        if (current.dev !== stat.dev || current.ino !== stat.ino)
          throw unavailable();
      } catch (error) {
        closeSync(fd);
        throw error;
      }
      lease = openSynchronousKernelFileLease(fd, unavailable);
    }
    try {
      if (!lease.acquire()) throw unavailable();
      this.checkDirectory();
    } catch (error) {
      lease.close();
      throw error;
    }
    return () => lease.close();
  }
  private update(
    change: (state: TelemetryState) => void,
    explicitlyEnable = false,
  ): TelemetryState {
    const release = this.lock();
    let temporary: string | undefined;
    try {
      const snapshot = this.snapshot();
      const persisted: PersistedState = snapshot.persisted ?? {
        version: 2,
        state: {
          version: 1,
          enabled: true,
          notice_version: 0,
          events: [],
        },
      };
      const state = persisted.state;
      if (explicitlyEnable && snapshot.legacyFingerprint !== undefined)
        persisted.acknowledged_legacy_optout = snapshot.legacyFingerprint;
      change(state);
      stateSchema.parse(state);
      temporary = join(this.directory, `${randomUUID()}.tmp`);
      writeFileSync(temporary, JSON.stringify(persisted), {
        flag: "wx",
        mode: 0o600,
      });
      renameSync(temporary, join(this.directory, "state-v2.json"));
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
  initialize(): TelemetryState {
    return this.update((state) => {
      if (!state.enabled) return;
      // Retained for compatibility with existing on-disk state, not a UI notice.
      state.notice_version = 1;
      state.installation_id ??= randomUUID();
    });
  }
  setEnabled(enabled: boolean): void {
    this.update((state) => {
      state.enabled = enabled;
      if (!enabled) state.events = [];
    }, enabled);
  }
  enqueue(input: unknown): void {
    const event = telemetryEventSchema.parse(input);
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
