import {
  defaultDiagnosticProbe,
  runDiagnostics,
  type Diagnostic,
  type DiagnosticContext,
} from "../doctor/diagnostics.js";

export type DoctorOutputFormat = "text" | "json";

export interface DoctorCommandOptions extends DiagnosticContext {
  readonly format: DoctorOutputFormat;
}

export interface DoctorCommandIO {
  writeStdout(value: string): void;
  writeStderr(value: string): void;
}

export interface DoctorCommandResult {
  readonly exitCode: 0 | 2;
  readonly diagnostics: readonly Diagnostic[];
}

export interface DoctorCommandDependencies {
  diagnose(context: DiagnosticContext): Promise<readonly Diagnostic[]>;
}

const DEFAULT_DEPENDENCIES: DoctorCommandDependencies = {
  diagnose: (context) => runDiagnostics(defaultDiagnosticProbe, context),
};

function renderText(result: DoctorCommandResult): string {
  return `${result.diagnostics
    .map((diagnostic) => {
      const remediation =
        diagnostic.remediation === undefined
          ? ""
          : `\n  Remediation: ${diagnostic.remediation}`;
      return `${diagnostic.status.toUpperCase()} ${diagnostic.id}: ${diagnostic.message}${remediation}`;
    })
    .join("\n")}\n`;
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
    io.writeStdout(
      options.format === "json"
        ? `${JSON.stringify(result, null, 2)}\n`
        : renderText(result),
    );
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
