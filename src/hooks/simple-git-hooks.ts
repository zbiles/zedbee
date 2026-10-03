import type { ScanHookName } from "./command.js";
import {
  hasZedbeeScanCommand,
  updateHuskyHook,
  ZEDBEE_COMMAND,
} from "./husky.js";

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`Expected ${field} to be an object.`);
  }
  return value as Record<string, unknown>;
}

export function updateSimpleGitHooksManifest(
  before: string,
  zedbeeCommand = ZEDBEE_COMMAND,
  hookName: ScanHookName = "pre-commit",
): string {
  const manifest = record(JSON.parse(before) as unknown, "package.json");
  const hooksValue = manifest["simple-git-hooks"];
  const hooks =
    hooksValue === undefined ? {} : record(hooksValue, "simple-git-hooks");
  const existing = hooks[hookName];
  if (existing !== undefined && typeof existing !== "string") {
    throw new TypeError(
      `Expected simple-git-hooks ${hookName} to be a string.`,
    );
  }
  hooks[hookName] = updateHuskyHook(existing ?? "", zedbeeCommand, hookName);
  manifest["simple-git-hooks"] = hooks;
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export function hasZedbeeSimpleGitHooksConfig(
  source: string,
  hookName: ScanHookName = "pre-commit",
): boolean {
  const manifest = record(JSON.parse(source) as unknown, "package.json");
  const hooksValue = manifest["simple-git-hooks"];
  if (hooksValue === undefined) return false;
  const hooks = record(hooksValue, "simple-git-hooks");
  const command = hooks[hookName];
  return typeof command === "string" && hasZedbeeScanCommand(command, hookName);
}
