import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  opendirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  type Stats,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  scanDetailsSchema,
  telemetryEventSchema,
  telemetryV1EventSchema,
  type ScanDetails,
  type TelemetryEvent,
  type TelemetryV1Event,
} from "./schema.js";

const envelopeSchema = z.strictObject({
  event_id: z.string().uuid(),
  run_id: z.string().uuid(),
  timestamp: z.string().datetime(),
  details: scanDetailsSchema,
});
const filename =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:json|tmp)$/u;
function owned(stat: Stats): void {
  if (
    stat.isSymbolicLink() ||
    (process.platform !== "win32" &&
      (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0))
  )
    throw Error("Unsafe telemetry details permissions");
}
export class TelemetryDetailsStore {
  readonly path: string;
  constructor(readonly directory: string) {
    this.path = join(directory, "details");
  }
  private directoryReady(create = false): boolean {
    try {
      const root = lstatSync(this.directory);
      owned(root);
      if (!root.isDirectory()) return false;
      if (create) {
        try {
          mkdirSync(this.path, { mode: 0o700 });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
      }
      const stat = lstatSync(this.path);
      owned(stat);
      return stat.isDirectory();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
  write(input: TelemetryV1Event, details: ScanDetails): void {
    const event = telemetryV1EventSchema.parse(input);
    if (event.environment === "ci" || event.event !== "scan_finished")
      throw Error("Invalid detail parent");
    const envelope = envelopeSchema.parse({
      event_id: event.event_id,
      run_id: event.run_id,
      timestamp: event.timestamp,
      details,
    });
    if (!this.directoryReady(true))
      throw Error("Details directory unavailable");
    const temporary = join(this.path, `${randomUUID()}.tmp`);
    try {
      writeFileSync(temporary, JSON.stringify(envelope), {
        flag: "wx",
        mode: 0o600,
      });
      renameSync(temporary, join(this.path, `${event.event_id}.json`));
    } finally {
      try {
        unlinkSync(temporary);
      } catch {}
    }
    this.prune();
  }
  read(event: TelemetryV1Event): ScanDetails | undefined {
    let fd: number | undefined;
    try {
      if (
        !this.directoryReady() ||
        event.event !== "scan_finished" ||
        event.environment === "ci" ||
        !z.string().uuid().safeParse(event.event_id).success
      )
        return undefined;
      const path = join(this.path, `${event.event_id}.json`);
      const before = lstatSync(path);
      owned(before);
      if (!before.isFile() || before.nlink !== 1) return undefined;
      fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const stat = fstatSync(fd);
      owned(stat);
      if (before.ino !== stat.ino || before.dev !== stat.dev) return undefined;
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 17_000)
        return undefined;
      const value = envelopeSchema.parse(JSON.parse(readFileSync(fd, "utf8")));
      if (
        value.event_id !== event.event_id ||
        value.run_id !== event.run_id ||
        value.timestamp !== event.timestamp
      )
        return undefined;
      return value.details;
    } catch {
      return undefined;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  private entries(): { name: string; stat: Stats }[] {
    if (!this.directoryReady()) return [];
    const entries: { name: string; stat: Stats }[] = [];
    const dir = opendirSync(this.path);
    try {
      for (let i = 0; i < 256; i++) {
        const entry = dir.readSync();
        if (!entry) break;
        if (!filename.test(entry.name)) continue;
        try {
          const stat = lstatSync(join(this.path, entry.name));
          owned(stat);
          if (stat.isFile() && stat.nlink === 1)
            entries.push({ name: entry.name, stat });
        } catch {}
      }
    } finally {
      dir.closeSync();
    }
    return entries;
  }
  remove(ids: readonly string[]): void {
    const names = new Set(
      ids
        .filter((id) => z.string().uuid().safeParse(id).success)
        .map((id) => `${id}.json`),
    );
    try {
      for (const entry of this.entries())
        if (names.has(entry.name)) unlinkSync(join(this.path, entry.name));
    } catch {}
  }
  clear(): void {
    try {
      for (const entry of this.entries())
        unlinkSync(join(this.path, entry.name));
    } catch {}
  }
  prune(pendingIds?: readonly string[]): void {
    try {
      const pending =
        pendingIds === undefined ? undefined : new Set(pendingIds);
      let count = 0;
      let bytes = 0;
      for (const entry of this.entries().sort(
        (a, b) => b.stat.mtimeMs - a.stat.mtimeMs,
      )) {
        const age = Date.now() - entry.stat.mtimeMs;
        const temporary = entry.name.endsWith(".tmp");
        const orphan =
          pending !== undefined &&
          !pending.has(entry.name.slice(0, -5)) &&
          age > 60_000;
        if (
          age > 7 * 86_400_000 ||
          (temporary && age > 60_000) ||
          (!temporary &&
            (orphan || count >= 100 || bytes + entry.stat.size > 256 * 1024))
        ) {
          unlinkSync(join(this.path, entry.name));
        } else if (!temporary) {
          count++;
          bytes += entry.stat.size;
        }
      }
    } catch {
      /* Optional detail maintenance cannot affect the command. */
    }
  }
}
export function enrichTelemetryEvent(
  event: TelemetryV1Event,
  details?: ScanDetails,
): TelemetryEvent {
  if (event.event === "scan_finished" && details !== undefined) {
    const enriched = telemetryEventSchema.safeParse({
      ...event,
      ...details,
      schema_version: 2,
    });
    if (enriched.success) return enriched.data;
  }
  return event;
}
