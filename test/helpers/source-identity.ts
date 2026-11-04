export { sourceEntityName } from "../../src/attribution/source-identity.js";
import { sourceEntityName } from "../../src/attribution/source-identity.js";

/** Express fixture ownership independently of the opaque digest bytes. */
export function syntaxIdentity(identity: string): string {
  const match = /^(function|method|class):([^:]+):(.*)$/u.exec(identity);
  if (match === null) throw new Error("Invalid fixture syntax identity");
  const name = (value: string): string => {
    if (
      value === "constructor" ||
      value === "default" ||
      value.startsWith("anonymous@")
    )
      return value;
    const structural = /^(.+)(@\d+(?:\.\d+)*)$/u.exec(value);
    return structural === null
      ? sourceEntityName(value)
      : `${sourceEntityName(structural[1]!)}${structural[2]}`;
  };
  const payload = match[3]!;
  const encoded = payload.includes("/")
    ? payload
        .split("/")
        .map((part) => {
          const separator = part.indexOf("=");
          const kind = part.slice(0, separator);
          return ["function", "class", "method", "variable"].includes(kind)
            ? `${kind}=${encodeURIComponent(name(decodeURIComponent(part.slice(separator + 1))))}`
            : part;
        })
        .join("/")
    : name(payload);
  return `${match[1]}:${match[2]}:${encoded}`;
}
