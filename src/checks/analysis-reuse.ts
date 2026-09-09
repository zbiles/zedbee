import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";

export interface AnalysisReuseSession {
  close(): Promise<void>;
}

class Session implements AnalysisReuseSession {
  closed = false;
  retainedBytes = 0;
  readonly values = new Map<
    symbol,
    Map<string, { value: unknown; bytes: number }>
  >();
  async close(): Promise<void> {
    this.closed = true;
    for (const store of this.values.values()) store.clear();
    this.values.clear();
    this.retainedBytes = 0;
  }
}

const current = new AsyncLocalStorage<Session>();

export function createAnalysisReuseSession(): AnalysisReuseSession {
  return new Session();
}

export async function withAnalysisReuseSession<T>(
  session: AnalysisReuseSession,
  run: () => Promise<T>,
): Promise<T> {
  if (!(session instanceof Session))
    throw new TypeError("Invalid analysis reuse owner.");
  if (session.closed) throw new Error("Analysis reuse session is closed.");
  return current.run(session, async () => {
    const result = await run();
    if (session.closed) throw new Error("Analysis reuse session is closed.");
    return result;
  });
}

export function analysisStore<T>(family: symbol):
  | {
      get(key: string): T | undefined;
      set(key: string, value: T, estimatedBytes: number): void;
      delete(key: string): void;
      clear(): void;
    }
  | undefined {
  const session = current.getStore();
  if (session === undefined) return undefined;
  if (session.closed) throw new Error("Analysis reuse session is closed.");
  let values = session.values.get(family);
  if (values === undefined) {
    values = new Map();
    session.values.set(family, values);
  }
  const store = values;
  return {
    get: (key) =>
      session.closed ? undefined : (store.get(key)?.value as T | undefined),
    set(key, value, estimatedBytes) {
      // A cancelled/in-flight operation must not repopulate a closed owner.
      if (session.closed) return;
      const bytes = estimatedBytes + key.length * 2 + 128;
      const previous = store.get(key)?.bytes ?? 0;
      // A retention budget, not a promise about total engine RSS. Programs use
      // conservative text-derived estimates; captures reserve their full bound.
      if (
        !Number.isSafeInteger(bytes) ||
        bytes < 0 ||
        session.retainedBytes - previous + bytes > 384 * 1024 * 1024 ||
        (store.size >= 256 && !store.has(key))
      )
        return;
      session.retainedBytes += bytes - previous;
      store.set(key, { value, bytes });
    },
    delete: (key) => {
      if (!session.closed) session.retainedBytes -= store.get(key)?.bytes ?? 0;
      store.delete(key);
    },
    clear() {
      if (!session.closed)
        for (const entry of store.values())
          session.retainedBytes -= entry.bytes;
      store.clear();
    },
  };
}

/** Exact serializable engine inputs; unsupported options deliberately bypass reuse. */
export function analysisKey(value: unknown): string | undefined {
  const ancestors = new Set<object>();
  function encode(item: unknown): string {
    if (item === undefined) return "undefined";
    if (item === null || typeof item === "boolean" || typeof item === "string")
      return JSON.stringify(item);
    if (typeof item === "number" && Number.isFinite(item))
      return JSON.stringify(item);
    if (typeof item !== "object" || ancestors.has(item))
      throw new TypeError("Unsupported analysis input");
    ancestors.add(item);
    try {
      if (Array.isArray(item)) {
        if (
          Object.getPrototypeOf(item) !== Array.prototype ||
          Reflect.ownKeys(item).length !== item.length + 1
        )
          throw new TypeError("Unsupported analysis input");
        for (let index = 0; index < item.length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(
            item,
            String(index),
          );
          if (descriptor === undefined || !("value" in descriptor))
            throw new TypeError("Unsupported analysis input");
        }
        return `[${item.map(encode).join(",")}]`;
      }
      if (
        Object.getPrototypeOf(item) !== Object.prototype &&
        Object.getPrototypeOf(item) !== null
      )
        throw new TypeError("Unsupported analysis input");
      const keys = Reflect.ownKeys(item);
      if (
        keys.some(
          (key) =>
            typeof key !== "string" ||
            !Object.getOwnPropertyDescriptor(item, key)?.enumerable ||
            !("value" in Object.getOwnPropertyDescriptor(item, key)!),
        )
      )
        throw new TypeError("Unsupported analysis input");
      return `{${Object.keys(item)
        .sort()
        .map(
          (key) =>
            `${JSON.stringify(key)}:${encode((item as Record<string, unknown>)[key])}`,
        )
        .join(",")}}`;
    } finally {
      ancestors.delete(item);
    }
  }
  try {
    return createHash("sha256").update(encode(value)).digest("hex");
  } catch {
    return undefined;
  }
}
