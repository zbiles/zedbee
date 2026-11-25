import type { InspectionContext } from "./adapter.js";

function getOrCreate<K extends object, V>(
  map: WeakMap<K, V>,
  key: K,
  create: () => V,
): V {
  const existing = map.get(key);
  if (existing !== undefined) return existing;
  const value = create();
  map.set(key, value);
  return value;
}

export function memoizeCompilerDecision<T>(
  acquire: (context: InspectionContext) => Promise<T>,
): (context: InspectionContext) => Promise<T> {
  type ByChanges = WeakMap<object, Promise<T>>;
  type ByTarget = WeakMap<object, ByChanges>;
  type ByBaseline = WeakMap<object, ByTarget>;
  type ByPolicy = WeakMap<object, ByBaseline>;
  const defaultPolicies: ByPolicy = new WeakMap();
  const owners = new WeakMap<AbortSignal, ByPolicy>();

  return (context) => {
    const { signal, baselineInspection, targetInspection, changeSet } = context;
    if (signal?.aborted === true) return Promise.reject(signal.reason);
    const policies =
      signal === undefined
        ? defaultPolicies
        : getOrCreate(owners, signal, () => new WeakMap());
    const byBaseline = getOrCreate(
      policies,
      context.filePolicyConfig ?? context.config,
      () => new WeakMap(),
    );
    const byTarget = getOrCreate(
      byBaseline,
      baselineInspection,
      () => new WeakMap(),
    );
    const byChanges = getOrCreate(
      byTarget,
      targetInspection,
      () => new WeakMap(),
    );
    return getOrCreate(byChanges, changeSet, () => {
      const pending = acquire(context);
      void pending.catch(() => byChanges.delete(changeSet));
      return pending;
    });
  };
}
