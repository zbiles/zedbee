import { satisfies } from "semver";

export const NODE_ENGINE_RANGE = "^22.17.0 || >=24.2.0";

export function isSupportedNodeVersion(version: string): boolean {
  return satisfies(version, NODE_ENGINE_RANGE);
}
