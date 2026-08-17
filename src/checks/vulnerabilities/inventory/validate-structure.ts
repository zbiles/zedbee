import { inventoryError } from "./errors.js";
import {
  MAX_LOCKFILE_NESTING,
  MAX_LOCKFILE_NODES,
  MAX_LOCKFILE_STRING_LENGTH,
} from "./limits.js";

export function validateParsedStructure(
  value: unknown,
  formatLabel: string,
): void {
  let nodes = 0;
  const seen = new Set<object>();
  const visit = (candidate: unknown, depth: number): void => {
    nodes += 1;
    if (nodes > MAX_LOCKFILE_NODES || depth > MAX_LOCKFILE_NESTING) {
      throw inventoryError(
        "LOCKFILE_LIMIT_EXCEEDED",
        `The ${formatLabel} lockfile exceeds Zedbee's structural safety limits.`,
      );
    }
    if (
      typeof candidate === "string" &&
      candidate.length > MAX_LOCKFILE_STRING_LENGTH
    ) {
      throw inventoryError(
        "LOCKFILE_LIMIT_EXCEEDED",
        `The ${formatLabel} lockfile contains an oversized string.`,
      );
    }
    if (typeof candidate !== "object" || candidate === null) return;
    if (seen.has(candidate)) {
      throw inventoryError(
        "LOCKFILE_INVALID",
        `The ${formatLabel} lockfile contains a cyclic structure.`,
      );
    }
    seen.add(candidate);
    if (Array.isArray(candidate)) {
      candidate.forEach((item) => visit(item, depth + 1));
    } else {
      for (const [key, item] of Object.entries(candidate)) {
        visit(key, depth + 1);
        visit(item, depth + 1);
      }
    }
    seen.delete(candidate);
  };
  visit(value, 1);
}
