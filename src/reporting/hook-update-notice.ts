export const HOOK_UPDATE_TITLE = "HOOK UPDATE NEEDED";

export const HOOK_UPDATE_NOTICE = Object.freeze({
  code: "HOOK_UPDATE_NEEDED" as const,
  message: "Swarm’s hooks need updating.",
  remediation: "Run zedbee init to refresh them.",
});

export const SHARED_HUSKY_UPDATE_NOTICE = Object.freeze({
  ...HOOK_UPDATE_NOTICE,
  hookOwner: "main-checkout" as const,
  remediation:
    "Run zedbee init in the main checkout to refresh the shared hooks.",
});

export type HookUpdateNotice =
  typeof HOOK_UPDATE_NOTICE | typeof SHARED_HUSKY_UPDATE_NOTICE;

/** Only fixed host-authored copy can enter presentation or persisted reports. */
export function hookUpdateNotice(report: {
  readonly hookUpdate?: HookUpdateNotice;
}): HookUpdateNotice | undefined {
  const notice = report.hookUpdate;
  if (notice?.code !== HOOK_UPDATE_NOTICE.code) return undefined;
  return "hookOwner" in notice && notice.hookOwner === "main-checkout"
    ? SHARED_HUSKY_UPDATE_NOTICE
    : HOOK_UPDATE_NOTICE;
}
