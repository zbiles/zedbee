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
    "Run the repository's hook setup in this checkout. To opt into tracked dispatchers for future worktrees, use zedbee init --hook tracked.",
});

export const SHARED_HUSKY_ACTIVATION_NOTICE = Object.freeze({
  ...HUSKY_ACTIVATION_NOTICE,
  hookOwner: "main-checkout" as const,
  message: "Swarm's shared Husky dispatcher is missing or inactive.",
  remediation: "Run the repository's hook setup in the main checkout.",
});

export const HUSKY_CUSTOM_RUNTIME_NOTICE = Object.freeze({
  code: "HUSKY_RUNTIME_UNVERIFIED" as const,
  message: "Swarm cannot verify the customized Husky dispatcher or helper.",
  remediation:
    "Inspect the Git-selected .husky/_ dispatcher and .husky/_/h in the hook's owning checkout; confirm that the helper invokes the .husky hook body. Preserve custom hooks.",
});

export const HUSKY_INSTALLATION_NOTICE = Object.freeze({
  code: "HUSKY_CLI_UNAVAILABLE" as const,
  message:
    "The Husky hook cannot start Swarm without a usable installation in this checkout.",
  remediation:
    "Restore this checkout's dependencies using the repository's package-manager instructions.",
});

const MANAGED_UPDATE_REASONS = {
  "outdated-command": "refresh the installed CLI command",
  "early-installation-check": "check for Swarm before other hook commands",
  "duplicate-installation-check": "remove the repeated installation check",
} as const;

export type ManagedHookUpdateReason = keyof typeof MANAGED_UPDATE_REASONS;
type ManagedHook = "pre-commit" | "pre-merge-commit";

interface ManagedHookUpdateNotice {
  readonly code: "HOOK_UPDATE_NEEDED";
  readonly message: string;
  readonly remediation: string;
  readonly hookOwner?: "main-checkout";
  readonly hook: ManagedHook;
  readonly reason: ManagedHookUpdateReason;
}

export function managedHookUpdateNotice(
  hook: ManagedHook,
  reason: ManagedHookUpdateReason,
  shared = false,
): ManagedHookUpdateNotice {
  const base = shared ? SHARED_HUSKY_UPDATE_NOTICE : HOOK_UPDATE_NOTICE;
  return Object.freeze({
    ...base,
    message: `${base.message} Update ${hook} to ${MANAGED_UPDATE_REASONS[reason]}.`,
    hook,
    reason,
  });
}

export type HookUpdateNotice =
  | ManagedHookUpdateNotice
  | typeof HOOK_UPDATE_NOTICE
  | typeof SHARED_HUSKY_UPDATE_NOTICE
  | typeof HUSKY_ACTIVATION_NOTICE
  | typeof SHARED_HUSKY_ACTIVATION_NOTICE
  | typeof HUSKY_INSTALLATION_NOTICE
  | typeof HUSKY_CUSTOM_RUNTIME_NOTICE;

/** Only fixed host-authored copy can enter presentation or persisted reports. */
export function hookUpdateNotice(report: {
  readonly hookUpdate?: HookUpdateNotice;
}): HookUpdateNotice | undefined {
  const notice = report.hookUpdate;
  if (typeof notice !== "object" || notice === null) return undefined;
  const shared = "hookOwner" in notice && notice.hookOwner === "main-checkout";
  switch (notice.code) {
    case "HOOK_UPDATE_NEEDED":
      if (
        "hook" in notice &&
        "reason" in notice &&
        (notice.hook === "pre-commit" || notice.hook === "pre-merge-commit") &&
        Object.hasOwn(MANAGED_UPDATE_REASONS, notice.reason)
      )
        return managedHookUpdateNotice(notice.hook, notice.reason, shared);
      return shared ? SHARED_HUSKY_UPDATE_NOTICE : HOOK_UPDATE_NOTICE;
    case "HUSKY_DISPATCHER_INACTIVE":
      return shared ? SHARED_HUSKY_ACTIVATION_NOTICE : HUSKY_ACTIVATION_NOTICE;
    case "HUSKY_RUNTIME_UNVERIFIED":
      return HUSKY_CUSTOM_RUNTIME_NOTICE;
    case "HUSKY_CLI_UNAVAILABLE":
      return HUSKY_INSTALLATION_NOTICE;
  }
}
