import { hasZedbeeScanCommand } from "./husky.js";

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`Expected ${field} to be an object.`);
  }
  return value as Record<string, unknown>;
}

export function updateSimpleGitHooksManifest(before: string): string {
  const manifest = record(JSON.parse(before) as unknown, "package.json");
  const hooksValue = manifest["simple-git-hooks"];
  const hooks =
    hooksValue === undefined ? {} : record(hooksValue, "simple-git-hooks");
  const existing = hooks["pre-commit"];
  if (existing !== undefined && typeof existing !== "string") {
    throw new TypeError("Expected simple-git-hooks pre-commit to be a string.");
  }
  const command = existing ?? "";
  if (!hasZedbeeScanCommand(command)) {
    hooks["pre-commit"] =
      `${command}${command.length === 0 ? "" : "\n"}npx --no-install zedbee scan`;
  }
  manifest["simple-git-hooks"] = hooks;
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export function hasZedbeeSimpleGitHooksConfig(source: string): boolean {
  const manifest = record(JSON.parse(source) as unknown, "package.json");
  const hooksValue = manifest["simple-git-hooks"];
  if (hooksValue === undefined) return false;
  const hooks = record(hooksValue, "simple-git-hooks");
  const command = hooks["pre-commit"];
  return typeof command === "string" && hasZedbeeScanCommand(command);
}
