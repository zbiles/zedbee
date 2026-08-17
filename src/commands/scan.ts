import { extname, isAbsolute, relative, resolve } from "node:path";
import { GitClient } from "../git/client.js";
import { renderJson } from "../renderers/json.js";
import { renderText } from "../renderers/text.js";
import { runScan, type RunScanOptions } from "../scan/run-scan.js";
import type { ScanReport } from "../scan/report.js";
import type {
  ReportingSurface,
  SourceExcerptOverride,
} from "../scan/reporting-options.js";

export type RequestedOutputFormat = "auto" | "ink" | "text" | "json";
export type OutputFormat = ReportingSurface;

export interface ScanCommandOptions {
  cwd: string;
  format: RequestedOutputFormat;
  color: boolean;
  animations: boolean;
  configPath?: string;
  sourceExcerpts?: SourceExcerptOverride;
  signal?: AbortSignal;
}

export interface ScanCommandIO {
  stdinIsTTY: boolean;
  stdoutIsTTY: boolean;
  width: number;
  env: Record<string, string | undefined>;
  writeStdout(value: string): void;
  writeStderr(value: string): void;
}

export interface InkRenderOptions {
  color: boolean;
  animations: boolean;
  width: number;
}

export interface ScanCommandDependencies {
  resolveRepositoryRoot(cwd: string): Promise<string>;
  scan(options: RunScanOptions): Promise<ScanReport>;
  renderInk(report: ScanReport, options: InkRenderOptions): Promise<void>;
  scanInk?(
    options: RunScanOptions,
    renderOptions: InkRenderOptions,
  ): Promise<ScanReport>;
}

export function selectOutputFormat(
  requested: RequestedOutputFormat,
  stdinIsTTY: boolean,
  stdoutIsTTY: boolean,
): OutputFormat {
  if (requested !== "auto") {
    return requested;
  }
  return stdinIsTTY && stdoutIsTTY ? "ink" : "text";
}

export function signalExitCode(signal: "SIGINT" | "SIGTERM"): 130 | 143 {
  return signal === "SIGINT" ? 130 : 143;
}

function validConfigPath(
  repositoryRoot: string,
  requested: string,
): string | undefined {
  const candidate = resolve(repositoryRoot, requested);
  const fromRoot = relative(repositoryRoot, candidate);
  if (
    extname(candidate) !== ".jsonc" ||
    fromRoot === "" ||
    isAbsolute(fromRoot) ||
    fromRoot === ".." ||
    fromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
  ) {
    return undefined;
  }
  return candidate;
}

const DEFAULT_DEPENDENCIES: ScanCommandDependencies = {
  async resolveRepositoryRoot(cwd) {
    return (await new GitClient(cwd).run(["rev-parse", "--show-toplevel"]))
      .stdout;
  },
  scan: runScan,
  async renderInk(report, options) {
    process.stdout.write(
      renderText(report, { width: options.width, color: options.color }),
    );
  },
  async scanInk(options, renderOptions) {
    const { runInkScan } = await import("../ui/render-ink.js");
    return runInkScan(options, renderOptions);
  },
};

export async function executeScanCommand(
  options: ScanCommandOptions,
  io: ScanCommandIO,
  dependencies: ScanCommandDependencies = DEFAULT_DEPENDENCIES,
): Promise<0 | 1 | 2> {
  try {
    const repositoryRoot = await dependencies.resolveRepositoryRoot(
      options.cwd,
    );
    const configPath =
      options.configPath === undefined
        ? undefined
        : validConfigPath(repositoryRoot, options.configPath);
    if (options.configPath !== undefined && configPath === undefined) {
      io.writeStderr(
        "Zedbee configuration must be a .jsonc file inside the repository.\n",
      );
      return 2;
    }

    const format = selectOutputFormat(
      options.format,
      io.stdinIsTTY,
      io.stdoutIsTTY,
    );
    const scanOptions: RunScanOptions = {
      repositoryRoot,
      reportingSurface: format,
      ...(options.sourceExcerpts === undefined
        ? {}
        : { sourceExcerpts: options.sourceExcerpts }),
      ...(configPath === undefined ? {} : { configPath }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    };
    const color = options.color && io.env.NO_COLOR === undefined;
    const inkOptions = {
      color,
      animations: options.animations,
      width: io.width,
    };

    if (format === "ink" && dependencies.scanInk !== undefined) {
      return (await dependencies.scanInk(scanOptions, inkOptions)).exitCode;
    }

    const report = await dependencies.scan(scanOptions);

    if (format === "json") {
      io.writeStdout(renderJson(report));
    } else if (format === "text") {
      io.writeStdout(renderText(report, { width: io.width, color: false }));
    } else {
      await dependencies.renderInk(report, inkOptions);
    }
    return report.exitCode;
  } catch {
    if (options.signal?.aborted === true) {
      return 2;
    }
    io.writeStderr("Zedbee could not complete the scan.\n");
    return 2;
  }
}
