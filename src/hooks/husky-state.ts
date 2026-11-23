import { join, resolve } from "node:path";
import type { ScanHookName } from "./command.js";
import { isStockHuskyDispatcher } from "./install.js";
import { readHookData } from "./read-hook-data.js";

export interface HuskyHook {
  readonly source?: string;
  readonly reachable: boolean;
  readonly dispatcher: boolean;
}

/** Read only known Husky layouts and require Git's executable entry point. */
export async function readHuskyHook(
  owner: string,
  hookPath: string,
  name: ScanHookName,
): Promise<HuskyHook | undefined> {
  const body = resolve(owner, ".husky", name);
  const dispatcher = hookPath === resolve(owner, ".husky", "_", name);
  if (!dispatcher && hookPath !== body) return undefined;
  const [source, entry, helper] = await Promise.all([
    readHookData(body),
    readHookData(hookPath, true),
    dispatcher ? readHookData(join(owner, ".husky", "_", "h")) : undefined,
  ]);
  return {
    ...(source === undefined ? {} : { source }),
    reachable: dispatcher
      ? isStockHuskyDispatcher(entry) && helper !== undefined
      : entry !== undefined,
    dispatcher,
  };
}
