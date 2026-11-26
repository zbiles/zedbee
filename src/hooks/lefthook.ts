import type { ScanHookName } from "./command.js";
import { parseDocument } from "yaml";
import {
  hasZedbeeScanCommand,
  replaceManagedZedbeeCommand,
  ZEDBEE_COMMAND,
} from "./husky.js";

type LefthookData = {
  readonly [name: string]: {
    readonly commands?: Readonly<
      Record<string, { readonly run?: unknown } | null>
    >;
  };
};

export function updateLefthookConfig(
  before: string | null | undefined,
  command = ZEDBEE_COMMAND,
  hookName: ScanHookName = "pre-commit",
): string {
  const source = before ?? "";
  const document = parseDocument(source.length === 0 ? "{}\n" : source, {
    strict: true,
  });
  if (document.errors.length > 0) {
    throw new TypeError("Expected valid Lefthook YAML.");
  }
  const data = (document.toJS() ?? {}) as LefthookData;
  let changed = false;
  let configured = false;
  const entries = data[hookName]?.commands ?? {};
  for (const [name, entry] of Object.entries(entries)) {
    const run = entry?.run;
    if (typeof run !== "string") continue;
    const updated = replaceManagedZedbeeCommand(run, command);
    if (updated !== run) {
      document.setIn([hookName, "commands", name, "run"], updated);
      changed = true;
    }
    configured ||= hasZedbeeScanCommand(updated, hookName);
  }
  if (configured) return changed ? document.toString({ lineWidth: 0 }) : source;
  let name = "zedbee";
  for (let suffix = 2; Object.hasOwn(entries, name); suffix += 1)
    name = `zedbee-${suffix}`;
  document.setIn([hookName, "commands", name, "run"], command);
  return document.toString({ lineWidth: 0 });
}

function hasZedbeeLefthookData(
  data: LefthookData,
  hookName: ScanHookName = "pre-commit",
): boolean {
  return Object.values(data[hookName]?.commands ?? {}).some(
    (entry) =>
      typeof entry?.run === "string" &&
      hasZedbeeScanCommand(entry.run, hookName),
  );
}

export function hasZedbeeLefthookConfig(
  source: string,
  hookName: ScanHookName = "pre-commit",
): boolean {
  const document = parseDocument(source, { strict: true });
  if (document.errors.length > 0) return false;
  return hasZedbeeLefthookData(
    (document.toJS() ?? {}) as LefthookData,
    hookName,
  );
}
