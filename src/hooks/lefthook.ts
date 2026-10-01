import { parseDocument } from "yaml";
import {
  hasZedbeeScanCommand,
  replaceManagedZedbeeCommand,
  ZEDBEE_COMMAND,
} from "./husky.js";

export function updateLefthookConfig(
  before: string | null | undefined,
  command = ZEDBEE_COMMAND,
): string {
  const source = before ?? "";
  const document = parseDocument(source.length === 0 ? "{}\n" : source, {
    strict: true,
  });
  if (document.errors.length > 0) {
    throw new TypeError("Expected valid Lefthook YAML.");
  }
  const data = document.toJS() as {
    readonly "pre-commit"?: {
      readonly commands?: Readonly<Record<string, { readonly run?: unknown }>>;
    };
  };
  if (hasZedbeeLefthookData(data)) {
    let changed = false;
    for (const [name, entry] of Object.entries(
      data["pre-commit"]?.commands ?? {},
    )) {
      if (typeof entry.run !== "string") continue;
      const updated = replaceManagedZedbeeCommand(entry.run, command);
      if (updated !== entry.run) {
        document.setIn(["pre-commit", "commands", name, "run"], updated);
        changed = true;
      }
    }
    return changed ? document.toString({ lineWidth: 0 }) : source;
  }
  document.setIn(["pre-commit", "commands", "zedbee", "run"], command);
  return document.toString({ lineWidth: 0 });
}

function hasZedbeeLefthookData(data: {
  readonly "pre-commit"?: {
    readonly commands?: Readonly<Record<string, { readonly run?: unknown }>>;
  };
}): boolean {
  return Object.values(data["pre-commit"]?.commands ?? {}).some(
    ({ run }) => typeof run === "string" && hasZedbeeScanCommand(run),
  );
}

export function hasZedbeeLefthookConfig(source: string): boolean {
  const document = parseDocument(source, { strict: true });
  if (document.errors.length > 0) return false;
  return hasZedbeeLefthookData(
    document.toJS() as {
      readonly "pre-commit"?: {
        readonly commands?: Readonly<
          Record<string, { readonly run?: unknown }>
        >;
      };
    },
  );
}
