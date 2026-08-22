import { createFilePolicyResolver } from "../../src/config/file-policy.js";
import type { ResolvedConfig } from "../../src/config/schema.js";
import type { ChangeSet } from "../../src/git/change-set.js";

const emptyChangeSet: ChangeSet = Object.freeze({
  files: new Map(),
  isEmpty: true,
  containsAddedLine: () => false,
});

export function testFilePolicyResolver(
  config: ResolvedConfig,
  changeSet: ChangeSet = emptyChangeSet,
) {
  return createFilePolicyResolver(config, changeSet);
}
