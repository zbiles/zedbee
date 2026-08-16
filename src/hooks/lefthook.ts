import { parseDocument } from "yaml";
import { hasZedbeeScanCommand } from "./husky.js";

export function updateLefthookConfig(
  before: string | null | undefined,
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
    return source;
  }
  document.setIn(
    ["pre-commit", "commands", "zedbee", "run"],
    "npx --no-install zedbee scan",
  );
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
