import { posix } from "node:path";

/** A tsconfig `extends` value as a list, in declaration order. */
export function configExtensions(config: Record<string, unknown>): unknown[] {
  return config.extends === undefined
    ? []
    : Array.isArray(config.extends)
      ? config.extends
      : [config.extends];
}

/** The paths TypeScript tries, in order, for a relative extends/reference. */
export function tsconfigCandidates(base: string): string[] {
  return [base, `${base}.json`, posix.join(base, "tsconfig.json")];
}
