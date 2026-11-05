import { createHash } from "node:crypto";
import type { Observation } from "../core/types.js";

/** Hash parsed names before they can become attribution or persisted metadata. */
export function sourceEntityName(name: string): string {
  return `name-${createHash("sha256")
    .update(JSON.stringify(["zedbee-source-name-v1", name]), "utf8")
    .digest("hex")}`;
}

const OPAQUE_NAME = /^name-[a-f0-9]{64}$/u;
const SYNTAX_NAME =
  /^(?:name-[a-f0-9]{64}(?:@\d+(?:\.\d+)*)?|anonymous@\d+(?:\.\d+)*|default|constructor)$/u;

/** Custom caches must obey the same source-safe representation as producers. */
export function assertSourceSafeEntityObservation(
  observation: Observation,
): void {
  const syntax =
    observation.check === "cyclomaticComplexity" ||
    observation.check === "readabilityComplexity";
  if (!syntax && observation.check !== "deadCode") return;
  const entity = observation.entity;
  if (entity === undefined || observation.comparisonIdentity !== undefined)
    throw new TypeError("Expected source-safe entity metadata");
  if (!syntax) {
    if (
      !OPAQUE_NAME.test(entity.name) ||
      observation.identity !==
        `${observation.rule}:${entity.file}:${entity.name}`
    )
      throw new TypeError("Expected opaque analyzer entity metadata");
    return;
  }
  if (
    !["function", "method", "class"].includes(entity.kind) ||
    !SYNTAX_NAME.test(entity.name)
  )
    throw new TypeError("Expected opaque syntax entity metadata");
  const prefix = `${entity.kind}:${entity.file}:`;
  if (!observation.identity.startsWith(prefix))
    throw new TypeError("Expected canonical syntax entity identity");
  const payload = observation.identity.slice(prefix.length);
  if (payload === entity.name) return;
  const segments = payload.split("/");
  for (const [index, segment] of segments.entries()) {
    const separator = segment.indexOf("=");
    const kind = segment.slice(0, separator);
    const encoded = segment.slice(separator + 1);
    const name = decodeURIComponent(encoded);
    const safe = ["function", "method", "class", "variable"].includes(kind)
      ? SYNTAX_NAME.test(name)
      : kind === "class-scope"
        ? /^class@\d+$/u.test(name)
        : kind === "object-scope"
          ? /^object@\d+(?:\.\d+)*$/u.test(name)
          : kind === "field-scope"
            ? /^field@\d+(?:\.\d+)*$/u.test(name)
            : kind === "member-scope"
              ? /^(?:static|instance)$/u.test(name)
              : kind === "member-role" &&
                /^(?:method|get|set|constructor|field|property)$/u.test(name);
    if (
      !safe ||
      encoded !== encodeURIComponent(name) ||
      (index === segments.length - 1 &&
        (kind !== entity.kind || name !== entity.name))
    )
      throw new TypeError(
        "Expected source-safe canonical syntax entity identity",
      );
  }
}
