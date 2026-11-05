/** Immutable facade: callers cannot mutate the authoritative backing map. */
export function readonlyMap<K, V>(
  entries: readonly (readonly [K, V])[],
): ReadonlyMap<K, V> {
  const internal = new Map(entries);
  let facade: ReadonlyMap<K, V>;
  facade = Object.freeze({
    get size() {
      return internal.size;
    },
    get(key: K) {
      return internal.get(key);
    },
    has(key: K) {
      return internal.has(key);
    },
    entries() {
      return internal.entries();
    },
    keys() {
      return internal.keys();
    },
    values() {
      return internal.values();
    },
    forEach(
      callback: (value: V, key: K, map: ReadonlyMap<K, V>) => void,
      thisArg?: unknown,
    ) {
      internal.forEach((value, key) =>
        callback.call(thisArg, value, key, facade),
      );
    },
    [Symbol.iterator]() {
      return internal[Symbol.iterator]();
    },
  });
  return facade;
}
