import { lstat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { TelemetryEnvironment } from "./policy.js";
import type { ScanDetails } from "./schema.js";

export type CallerContext = Pick<
  ScanDetails,
  "caller_ai_tool" | "caller_ai_tool_candidates" | "caller_ai_tool_source"
>;
export type RepositoryToolContext = Pick<
  ScanDetails,
  | "detected_ai_tools"
  | "generic_agent_instructions_detected"
  | "repo_ai_detection_status"
>;
export interface DetectionOptions {
  budgetMs?: number;
  maxScopes?: number;
  maxProbes?: number;
}
export function callerContext(env: TelemetryEnvironment): CallerContext {
  const candidates: ScanDetails["caller_ai_tool_candidates"] = [];
  if (env.CLAUDECODE === "1") candidates.push("claude_code");
  if (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(
      env.CODEX_THREAD_ID ?? "",
    )
  )
    candidates.push("codex");
  return {
    caller_ai_tool:
      candidates.length === 0
        ? "unknown"
        : candidates.length === 1
          ? candidates[0]!
          : "ambiguous",
    caller_ai_tool_candidates: candidates,
    caller_ai_tool_source: candidates.length ? "environment_hint" : "none",
  };
}
export function emptyRepositoryContext(): RepositoryToolContext {
  return {
    detected_ai_tools: [],
    generic_agent_instructions_detected: false,
    repo_ai_detection_status: "unavailable",
  };
}
const markers = [
  [".codex", "directory", "codex"],
  ["CLAUDE.md", "file", "claude_code"],
  ["CLAUDE.local.md", "file", "claude_code"],
  [".claude", "directory", "claude_code"],
  [".cursorrules", "file", "cursor"],
  [".cursor", "directory", "cursor"],
  ["AGENTS.md", "file", "generic"],
  ["AGENTS.override.md", "file", "generic"],
  [".agents", "directory", "generic"],
] as const;
function contained(root: string, path: string): boolean {
  const from = relative(root, path);
  return (
    from === "" ||
    (!isAbsolute(from) && from !== ".." && !from.startsWith(`..${sep}`))
  );
}
export async function detectRepositoryTools(
  root: string,
  cwd: string,
  options: DetectionOptions = {},
): Promise<RepositoryToolContext> {
  root = resolve(root);
  cwd = resolve(cwd);
  if (!contained(root, cwd)) return emptyRepositoryContext();
  const result: RepositoryToolContext = {
    ...emptyRepositoryContext(),
    repo_ai_detection_status: "complete",
  };
  const tools = new Set<ScanDetails["detected_ai_tools"][number]>();
  const started = performance.now();
  const budget = Math.max(0, Math.min(1000, options.budgetMs ?? 25));
  const maximumScopes = Math.max(1, Math.min(16, options.maxScopes ?? 16));
  const maximumProbes = Math.max(0, Math.min(256, options.maxProbes ?? 256));
  const scopes = [root];
  const pieces = relative(root, cwd).split(sep).filter(Boolean);
  let scope = root;
  for (const piece of pieces) {
    if (scopes.length >= maximumScopes) {
      result.repo_ai_detection_status = "partial";
      break;
    }
    scope = join(scope, piece);
    scopes.push(scope);
  }
  let probes = 0;
  for (const directory of scopes) {
    if (performance.now() - started >= budget || probes >= maximumProbes) {
      result.repo_ai_detection_status = "partial";
      break;
    }
    probes++;
    try {
      const stat = await lstat(directory);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        result.repo_ai_detection_status = "partial";
        break;
      }
    } catch {
      result.repo_ai_detection_status =
        directory === root ? "unavailable" : "partial";
      break;
    }
    for (const [name, kind, tool] of markers) {
      if (performance.now() - started >= budget || probes >= maximumProbes) {
        result.repo_ai_detection_status = "partial";
        break;
      }
      probes++;
      try {
        const stat = await lstat(join(directory, name));
        if (stat.isSymbolicLink()) {
          result.repo_ai_detection_status = "partial";
          continue;
        }
        if (!(kind === "file" ? stat.isFile() : stat.isDirectory())) continue;
        if (tool === "generic")
          result.generic_agent_instructions_detected = true;
        else tools.add(tool);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT")
          result.repo_ai_detection_status = "partial";
      }
    }
  }
  result.detected_ai_tools = [...tools].sort();
  return result;
}
