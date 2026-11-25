import { posix } from "node:path";

export function referencedConfigPath(base: string): string {
  return base.endsWith(".json") ? base : posix.join(base, "tsconfig.json");
}

/** Relative extends checks a file and then its .json spelling. A project reference names a config or a directory. */
export function configCandidates(
  base: string,
  kind: "extends" | "reference",
): readonly string[] {
  if (kind === "reference") return [referencedConfigPath(base)];
  return base.endsWith(".json") ? [base] : [base, base + ".json"];
}
