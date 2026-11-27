import type { ScanHookName } from "./command.js";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

const GIT_ROOT = '(cd "$(git rev-parse --show-toplevel)" && ';

/** Self-contained: this guard must still run when the npm package is absent. */
function installationGuard(
  cliPath: string,
  hookName: ScanHookName = "pre-commit",
): string {
  const cli = shellQuote(cliPath);
  const packagePath = cliPath.slice(
    0,
    cliPath.indexOf("/node_modules/zedbee/") + "/node_modules/zedbee".length,
  );
  const action = hookName === "pre-merge-commit" ? "merge" : "commit";
  const messages = [
    `Zedbee could not start: ${cliPath} is missing or unreadable.`,
    `Restore this checkout's dependencies using the repository's package-manager instructions, including the Zedbee installation at ${packagePath}.`,
    `No scan ran. Retry the ${action} after installation completes.`,
  ]
    .map(shellQuote)
    .join(" ");
  return `{ if [ ! -f ${cli} ] || [ ! -r ${cli} ]; then printf '%s\\n' ${messages} >&2; exit 2; fi; }`;
}

export function installedHookCommand(
  cliPath: string,
  hookName: ScanHookName = "pre-commit",
): string {
  return `${GIT_ROOT}${installationGuard(cliPath, hookName)} && node ${shellQuote(cliPath)} scan --hook-invocation${hookName === "pre-merge-commit" ? " --merge" : ""})`;
}

export function installedHookPreflight(
  cliPath: string,
  hookName: ScanHookName,
): string {
  return `${GIT_ROOT}${installationGuard(cliPath, hookName)}) || exit $?`;
}

export function isInstalledHookPreflight(line: string): boolean {
  const match = / && \{ if \[ ! -f '(.+)' \] \|\| \[ ! -r /u.exec(line);
  if (match === null) return false;
  const cliPath = match[1]!.replaceAll("'\\''", "'");
  return (
    installedHookPreflight(cliPath, "pre-commit") === line ||
    installedHookPreflight(cliPath, "pre-merge-commit") === line
  );
}

/** Exact reconstruction recognizes only our generated guard, not custom shell. */
export function guardedHookInvocation(
  command: string,
): { cliPath: string; hookName: ScanHookName } | undefined {
  const match = / && node '(.*)' scan --hook-invocation( --merge)?\)$/u.exec(
    command,
  );
  if (match === null) return undefined;
  const cliPath = match[1]!.replaceAll("'\\''", "'");
  const hookName = match[2] === undefined ? "pre-commit" : "pre-merge-commit";
  if (installedHookCommand(cliPath, hookName) !== command) return undefined;
  return { cliPath, hookName };
}

/** Previous generated command, retained solely for exact stock-hook migration. */
export function previousInstalledHookCommand(
  command: string,
): string | undefined {
  const invocation = guardedHookInvocation(command);
  if (invocation === undefined) return undefined;
  return unguardedInstalledHookCommand(invocation.cliPath, invocation.hookName);
}

export function unguardedInstalledHookCommand(
  cliPath: string,
  hookName: ScanHookName,
): string {
  return `${GIT_ROOT}node ${shellQuote(cliPath)} scan --hook-invocation${hookName === "pre-merge-commit" ? " --merge" : ""})`;
}

export function managedHookInvocation(command: string) {
  const guarded = guardedHookInvocation(command);
  if (guarded !== undefined) return guarded;
  const match = / && node '(.*)' scan --hook-invocation( --merge)?\)$/u.exec(
    command,
  );
  if (match === null) return undefined;
  const cliPath = match[1]!.replaceAll("'\\''", "'");
  const hookName = match[2] === undefined ? "pre-commit" : "pre-merge-commit";
  return unguardedInstalledHookCommand(cliPath, hookName) === command
    ? ({ cliPath, hookName } as const)
    : undefined;
}
