import {
  normalizeManagedAutomaticFix,
  normalizeRepositoryRelativePath,
} from "../attribution/fingerprint.js";
import type { ManagedAutomaticFix } from "../core/types.js";

/** Bind only validated managed fix actions to the host's installed CLI. */
export function fixCommandArguments(
  automaticFix: ManagedAutomaticFix,
  installedCliCommand?: readonly string[],
): readonly string[] {
  const canonical = normalizeManagedAutomaticFix(automaticFix);
  if (
    installedCliCommand?.length !== 2 ||
    installedCliCommand[0] !== "node" ||
    !installedCliCommand[1]?.startsWith("./")
  ) {
    return canonical.command;
  }
  const path = installedCliCommand[1];
  try {
    if (`./${normalizeRepositoryRelativePath(path)}` !== path) {
      return canonical.command;
    }
  } catch {
    return canonical.command;
  }
  return Object.freeze([...installedCliCommand, ...canonical.command.slice(3)]);
}

export function fixCommandText(
  automaticFix: ManagedAutomaticFix,
  installedCliCommand?: readonly string[],
): string {
  const args = fixCommandArguments(automaticFix, installedCliCommand);
  return args[0] === "node"
    ? `(cd "$(git rev-parse --show-toplevel)" && node '${args[1]!.replaceAll("'", "'\\''")}' ${args.slice(2).join(" ")})`
    : args.join(" ");
}
