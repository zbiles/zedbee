import { updateHuskyHook } from "./husky.js";

export function updateRawGitHook(before: string | null | undefined): string {
  return updateHuskyHook(before);
}
