import {
  defaultDiagnosticProbe,
  runDiagnostics,
  type Diagnostic,
  type DiagnosticContext,
} from "../doctor/diagnostics.js";
import {
  terminalColorEnabled,
  terminalText,
  type TerminalTextTone,
} from "../renderers/terminal-style.js";

export type DoctorOutputFormat = "auto" | "text" | "json";

export interface DoctorCommandOptions extends DiagnosticContext {
  readonly format: DoctorOutputFormat;
  readonly color: boolean;
}

export interface DoctorCommandIO {
  readonly stdoutIsTTY: boolean;
  readonly width: number;
  readonly env: Record<string, string | undefined>;
  writeStdout(value: string): void;
  writeStderr(value: string): void;
}

export interface DoctorCommandResult {
  readonly exitCode: 0 | 2;
  readonly diagnostics: readonly Diagnostic[];
}

export interface DoctorCommandDependencies {
  diagnose(context: DiagnosticContext): Promise<readonly Diagnostic[]>;
  renderDashboard?(
    diagnostics: readonly Diagnostic[],
    options: { readonly width: number; readonly color: boolean },
  ): Promise<void>;
}

async function renderDashboard(
  diagnostics: readonly Diagnostic[],
  options: { readonly width: number; readonly color: boolean },
): Promise<void> {
  const { runInkDoctor } = await import("../ui/doctor-dashboard.js");
  await runInkDoctor(diagnostics, options);
}

const DEFAULT_DEPENDENCIES: DoctorCommandDependencies = {
  diagnose: (context) => runDiagnostics(defaultDiagnosticProbe, context),
  renderDashboard,
};

const MINIMUM_DASHBOARD_WIDTH = 80;
const INIT_COMMAND = "zedbee init";

function renderRemediation(diagnostic: Diagnostic, color: boolean): string {
  if (diagnostic.remediation === undefined) return "";
  const commandIndex = diagnostic.remediation.indexOf(INIT_COMMAND);
  if (diagnostic.id !== "hook-state" || commandIndex < 0) {
    return `\n${terminalText(`  Remediation: ${diagnostic.remediation}`, "reason", color)}`;
  }
  return `\n${terminalText("  Remediation:", "reason", color)}${terminalText(` ${diagnostic.remediation.slice(0, commandIndex)}`, "primary", color)}${terminalText(INIT_COMMAND, "reason", color)}${terminalText(diagnostic.remediation.slice(commandIndex + INIT_COMMAND.length), "primary", color)}`;
}

function renderText(result: DoctorCommandResult, color: boolean): string {
  return `${result.diagnostics
    .map((diagnostic) => {
      const remediation = renderRemediation(diagnostic, color);
      const statusTone: TerminalTextTone =
        diagnostic.status === "pass"
          ? "pass"
          : diagnostic.status === "warning"
            ? "warning"
            : "failure";
      return `${terminalText(diagnostic.status.toUpperCase(), statusTone, color)} ${terminalText(diagnostic.id, "primary", color)}${terminalText(`: ${diagnostic.message}`, "secondary", color)}${remediation}`;
    })
    .join("\n\n")}\n`;
}

export async function executeDoctorCommand(
  options: DoctorCommandOptions,
  io: DoctorCommandIO,
  dependencies: DoctorCommandDependencies = DEFAULT_DEPENDENCIES,
): Promise<DoctorCommandResult> {
  try {
    const diagnostics = Object.freeze([
      ...(await dependencies.diagnose({
        cwd: options.cwd,
        environment: options.environment,
        ...(options.configPath === undefined
          ? {}
          : { configPath: options.configPath }),
      })),
    ]);
    const exitCode = diagnostics.some(({ status }) => status === "fail")
      ? (2 as const)
      : (0 as const);
    const result = Object.freeze({ exitCode, diagnostics });
    const dashboard =
      options.format === "auto" &&
      io.stdoutIsTTY &&
      io.width >= MINIMUM_DASHBOARD_WIDTH &&
      io.env.TERM !== "dumb" &&
      io.env.CI === undefined;
    if (options.format === "json") {
      io.writeStdout(`${JSON.stringify(result, null, 2)}\n`);
    } else if (dashboard) {
      await (dependencies.renderDashboard ?? renderDashboard)(
        result.diagnostics,
        {
          width: io.width,
          color: options.color && io.env.NO_COLOR === undefined,
        },
      );
    } else {
      io.writeStdout(
        renderText(
          result,
          terminalColorEnabled(options.color, io.stdoutIsTTY, io.env),
        ),
      );
    }
    return result;
  } catch {
    const result = Object.freeze({
      exitCode: 2 as const,
      diagnostics: Object.freeze([
        {
          id: "doctor",
          status: "fail" as const,
          message: "Zedbee could not complete diagnostics.",
        },
      ]),
    });
    io.writeStderr("Zedbee could not complete diagnostics.\n");
    return result;
  }
}
