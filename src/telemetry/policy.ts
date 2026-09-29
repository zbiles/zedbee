export type TelemetryEnvironment = Readonly<Record<string, string | undefined>>;
export function telemetryDisabled(env: TelemetryEnvironment): boolean {
  return env.ZEDBEE_TELEMETRY_DISABLED === "1" || env.DO_NOT_TRACK === "1";
}
function truthy(value: string | undefined): boolean {
  return (
    value !== undefined &&
    !["", "0", "false", "no", "off"].includes(value.trim().toLowerCase())
  );
}
export function telemetryContext(env: TelemetryEnvironment): {
  environment: "ci" | "ci_not_detected";
  ci_provider?: "github_actions" | "gitlab_ci" | "generic" | "unknown";
} {
  const github = truthy(env.GITHUB_ACTIONS);
  const gitlab = truthy(env.GITLAB_CI);
  if (github || gitlab)
    return {
      environment: "ci",
      ci_provider:
        github && gitlab ? "unknown" : github ? "github_actions" : "gitlab_ci",
    };
  if (truthy(env.CI)) return { environment: "ci", ci_provider: "generic" };
  if (env.ZEDBEE_TELEMETRY_CONTEXT === "ci")
    return { environment: "ci", ci_provider: "unknown" };
  return { environment: "ci_not_detected" };
}
