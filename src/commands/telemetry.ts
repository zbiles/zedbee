import { TelemetryStore, telemetryDirectory } from "../telemetry/state.js";
import {
  telemetryContext,
  telemetryDisabled,
  type TelemetryEnvironment,
} from "../telemetry/policy.js";
export function executeTelemetryCommand(
  operation: "status" | "enable" | "disable",
  env: TelemetryEnvironment,
  io: { writeStdout(value: string): void; writeStderr(value: string): void },
  format: "text" | "json" = "text",
): 0 | 2 {
  try {
    const store = new TelemetryStore(telemetryDirectory(env));
    if (operation !== "status") store.setEnabled(operation === "enable");
    const state = store.read();
    const reason = telemetryDisabled(env)
      ? "environment_override"
      : state?.enabled === false
        ? "saved_opt_out"
        : "enabled_by_default_or_preference";
    const result = {
      enabled: !telemetryDisabled(env) && state?.enabled !== false,
      reason,
      ...telemetryContext(env),
      installationId: state?.installation_id ?? null,
    };
    io.writeStdout(
      format === "json"
        ? `${JSON.stringify(result)}\n`
        : `Usage telemetry: ${result.enabled ? "enabled" : "disabled"} (${reason}).\n${result.installationId ? `Local telemetry ID: ${result.installationId}\n` : ""}Disable in any environment: ZEDBEE_TELEMETRY_DISABLED=1\nDisabling clears queued local events; it does not delete data already received.\n`,
    );
    return 0;
  } catch {
    io.writeStderr(
      "Zedbee could not safely read or update telemetry preferences. Collection is skipped for unreadable preferences. Set ZEDBEE_TELEMETRY_DISABLED=1 to disable it; retry if another command is updating settings.\n",
    );
    return 2;
  }
}
