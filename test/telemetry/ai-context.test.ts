import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  callerContext,
  detectRepositoryTools,
} from "../../src/telemetry/ai-context.js";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "ai-tool-context-"));
  roots.push(root);
  return root;
}
describe("caller context", () => {
  it("retains conflicting runtime candidates without returning their raw identifiers", () => {
    const value = callerContext({
      CODEX_THREAD_ID: "c5c78fe1-7c36-46fe-8c71-f5118081c84b",
      CLAUDECODE: "1",
    });
    expect(value).toEqual({
      caller_ai_tool: "ambiguous",
      caller_ai_tool_candidates: ["claude_code", "codex"],
      caller_ai_tool_source: "environment_hint",
    });
    expect(JSON.stringify(value)).not.toContain("c5c78fe1");
  });
  it("ignores unrelated credentials, unverified Cursor flags, and false/malformed values", () => {
    expect(
      callerContext({
        CLAUDECODE: "0",
        CODEX_THREAD_ID: "private-value",
        CURSOR_AGENT: "1",
        OPENAI_API_KEY: "private-secret",
      }),
    ).toEqual({
      caller_ai_tool: "unknown",
      caller_ai_tool_candidates: [],
      caller_ai_tool_source: "none",
    });
  });
});
describe("repository tool markers", () => {
  it("keeps every tool independently and detects package-local generic instructions", async () => {
    const root = await fixture();
    await Promise.all([
      mkdir(join(root, ".claude")),
      mkdir(join(root, ".codex")),
      mkdir(join(root, ".cursor")),
      mkdir(join(root, "package")),
    ]);
    await writeFile(join(root, "package", "AGENTS.md"), "PRIVATE INSTRUCTIONS");
    const value = await detectRepositoryTools(root, join(root, "package"), {
      budgetMs: 1000,
    });
    expect(value).toEqual({
      detected_ai_tools: ["claude_code", "codex", "cursor"],
      generic_agent_instructions_detected: true,
      repo_ai_detection_status: "complete",
    });
    expect(JSON.stringify(value)).not.toMatch(/PRIVATE|ai-tool-context/);
  });
  it("reports partial evidence for symlinks and never follows an ancestor outside the root", async () => {
    const root = await fixture();
    const outside = await fixture();
    await mkdir(join(outside, ".claude"));
    await symlink(outside, join(root, "linked"));
    await symlink(join(outside, ".claude"), join(root, ".claude"));
    const value = await detectRepositoryTools(root, join(root, "linked"), {
      budgetMs: 1000,
    });
    expect(value.detected_ai_tools).toEqual([]);
    expect(value.repo_ai_detection_status).toBe("partial");
    expect(
      (await detectRepositoryTools(root, outside)).repo_ai_detection_status,
    ).toBe("unavailable");
  });
  it("does not interpret an exhausted probe budget as absence", async () => {
    const root = await fixture();
    expect(
      (await detectRepositoryTools(root, root, { maxProbes: 0 }))
        .repo_ai_detection_status,
    ).toBe("partial");
  });
});
