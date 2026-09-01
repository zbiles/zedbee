import { displayLabel } from "../core/display-text.js";

const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

export function isGitObjectId(value: unknown): value is string {
  return typeof value === "string" && OBJECT_ID.test(value);
}

export function validateRequestedBase(value: unknown): string {
  const requestedBase = displayLabel(value, "requested base");
  if (requestedBase.startsWith("-")) {
    throw new TypeError("Expected a non-option requested base");
  }
  return requestedBase;
}

export function safeRequestedBase(value: unknown): string | undefined {
  try {
    return validateRequestedBase(value);
  } catch {
    return undefined;
  }
}
