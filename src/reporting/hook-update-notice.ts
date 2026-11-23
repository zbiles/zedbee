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

export const HUSKY_ACTIVATION_NOTICE = Object.freeze({
  code: "HUSKY_DISPATCHER_INACTIVE" as const,
  message: "Swarm's Husky dispatcher is missing or inactive in this checkout.",
  remediation:
    "Run the repository's hook setup in this checkout. With Husky 9, rerun zedbee init and commit the listed dispatchers for future worktrees.",
});

export const SHARED_HUSKY_ACTIVATION_NOTICE = Object.freeze({
  ...HUSKY_ACTIVATION_NOTICE,
  hookOwner: "main-checkout" as const,
  message: "Swarm's shared Husky dispatcher is missing or inactive.",
  remediation: "Run the repository's hook setup in the main checkout.",
});

export const HUSKY_INSTALLATION_NOTICE = Object.freeze({
  code: "HUSKY_CLI_UNAVAILABLE" as const,
  message:
    "The Husky hook cannot start Swarm without a usable installation in this checkout.",
  remediation:
    "Restore this checkout's dependencies using the repository's package-manager instructions.",
});

export type HookUpdateNotice =
  | typeof HOOK_UPDATE_NOTICE
  | typeof SHARED_HUSKY_UPDATE_NOTICE
  | typeof HUSKY_ACTIVATION_NOTICE
  | typeof SHARED_HUSKY_ACTIVATION_NOTICE
  | typeof HUSKY_INSTALLATION_NOTICE;

/** Only fixed host-authored copy can enter presentation or persisted reports. */
export function hookUpdateNotice(report: {
  readonly hookUpdate?: HookUpdateNotice;
}): HookUpdateNotice | undefined {
  const notice = report.hookUpdate;
  if (typeof notice !== "object" || notice === null) return undefined;
  const shared = "hookOwner" in notice && notice.hookOwner === "main-checkout";
  switch (notice.code) {
    case "HOOK_UPDATE_NEEDED":
      return shared ? SHARED_HUSKY_UPDATE_NOTICE : HOOK_UPDATE_NOTICE;
    case "HUSKY_DISPATCHER_INACTIVE":
      return shared ? SHARED_HUSKY_ACTIVATION_NOTICE : HUSKY_ACTIVATION_NOTICE;
    case "HUSKY_CLI_UNAVAILABLE":
      return HUSKY_INSTALLATION_NOTICE;
  }
}
