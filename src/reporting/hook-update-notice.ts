export const HOOK_UPDATE_TITLE = "HOOK UPDATE NEEDED";

export const HOOK_UPDATE_NOTICE = Object.freeze({
  code: "HOOK_UPDATE_NEEDED" as const,
  message: "Swarm’s hooks need updating.",
  remediation: "Run zedbee init to refresh them.",
});

export type HookUpdateNotice = typeof HOOK_UPDATE_NOTICE;

/** Only fixed host-authored copy can enter presentation or persisted reports. */
export function hookUpdateNotice(report: {
  readonly hookUpdate?: HookUpdateNotice;
}): HookUpdateNotice | undefined {
  return report.hookUpdate?.code === HOOK_UPDATE_NOTICE.code
    ? HOOK_UPDATE_NOTICE
    : undefined;
}
