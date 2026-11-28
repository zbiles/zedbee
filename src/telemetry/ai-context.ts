import { lstat, realpath } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { isContainedPath as contained } from "../inspection/paths.js";
import type { TelemetryEnvironment } from "./policy.js";
import { callerAiToolFields, type ScanDetails } from "./schema.js";

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
  permitted?: () => boolean;
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
    ...callerAiToolFields(candidates),
    caller_ai_tool_candidates: candidates,
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
type Marker = (typeof markers)[number];
type MarkerProbe = "present" | "absent" | "partial";
type DetectedTool = ScanDetails["detected_ai_tools"][number];

async function containedScope(
  root: string,
  cwd: string,
): Promise<{ root: string; cwd: string } | undefined> {
  if (contained(root, cwd)) return { root, cwd };
  try {
    const physicalRoot = await realpath(root);
    const physicalCwd = await realpath(cwd);
    return contained(physicalRoot, physicalCwd)
      ? { root: physicalRoot, cwd: physicalCwd }
      : undefined;
  } catch {
    return undefined;
  }
}

function detectionScopes(
  root: string,
  cwd: string,
  maximumScopes: number,
): { scopes: string[]; truncated: boolean } {
  const scopes = [root];
  let scope = root;
  for (const piece of relative(root, cwd).split(sep).filter(Boolean)) {
    if (scopes.length >= maximumScopes) return { scopes, truncated: true };
    scope = join(scope, piece);
    scopes.push(scope);
  }
  return { scopes, truncated: false };
}

async function scopeStatus(
  directory: string,
  root: string,
): Promise<"ok" | "partial" | "unavailable"> {
  try {
    const stat = await lstat(directory);
    return stat.isSymbolicLink() || !stat.isDirectory() ? "partial" : "ok";
  } catch {
    return directory === root ? "unavailable" : "partial";
  }
}

async function probeMarker(
  directory: string,
  [name, kind]: Marker,
): Promise<MarkerProbe> {
  try {
    const stat = await lstat(join(directory, name));
    if (stat.isSymbolicLink()) return "partial";
    const matches = kind === "file" ? stat.isFile() : stat.isDirectory();
    return matches ? "present" : "absent";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? "absent"
      : "partial";
  }
}

function recordMarkers(
  result: RepositoryToolContext,
  tools: Set<DetectedTool>,
  outcomes: readonly (readonly [Marker[2], MarkerProbe])[],
): void {
  for (const [tool, outcome] of outcomes) {
    if (outcome === "partial") result.repo_ai_detection_status = "partial";
    if (outcome !== "present") continue;
    if (tool === "generic") result.generic_agent_instructions_detected = true;
    else tools.add(tool);
  }
}

export async function detectRepositoryTools(
  root: string,
  cwd: string,
  options: DetectionOptions = {},
): Promise<RepositoryToolContext> {
  const scope = await containedScope(resolve(root), resolve(cwd));
  if (scope === undefined) return emptyRepositoryContext();
  const result: RepositoryToolContext = {
    ...emptyRepositoryContext(),
    repo_ai_detection_status: "complete",
  };
  const tools = new Set<DetectedTool>();
  const started = performance.now();
  const budget = Math.max(0, Math.min(1000, options.budgetMs ?? 25));
  const maximumScopes = Math.max(1, Math.min(16, options.maxScopes ?? 16));
  const maximumProbes = Math.max(0, Math.min(256, options.maxProbes ?? 256));
  const overBudget = () => performance.now() - started >= budget;
  const { scopes, truncated } = detectionScopes(
    scope.root,
    scope.cwd,
    maximumScopes,
  );
  if (truncated) result.repo_ai_detection_status = "partial";
  let probes = 0;
  for (const directory of scopes) {
    if (
      options.permitted?.() === false ||
      overBudget() ||
      probes >= maximumProbes
    ) {
      result.repo_ai_detection_status = "partial";
      break;
    }
    probes++;
    const status = await scopeStatus(directory, scope.root);
    if (status !== "ok") {
      result.repo_ai_detection_status = status;
      break;
    }
    const allowed = overBudget() ? 0 : Math.max(0, maximumProbes - probes);
    const batch = markers.slice(0, allowed);
    probes += batch.length;
    if (batch.length < markers.length)
      result.repo_ai_detection_status = "partial";
    recordMarkers(
      result,
      tools,
      await Promise.all(
        batch.map(
          async (marker) =>
            [marker[2], await probeMarker(directory, marker)] as const,
        ),
      ),
    );
  }
  result.detected_ai_tools = [...tools].sort();
  return result;
}
