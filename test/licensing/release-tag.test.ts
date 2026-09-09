import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createInspectionFixture } from "../inspection/fixture.js";

const script = fileURLToPath(
  new URL("../../scripts/release-check.mjs", import.meta.url),
);

describe("release tag preflight", () => {
  it.each([
    ["refs/tags/v0.1.0-beta.1", 0],
    ["refs/tags/v9.9.9", 1],
    ["refs/heads/main", 0],
    ["", 0],
  ])("checks %s without running verification jobs", async (ref, status) => {
    const fixture = await createInspectionFixture();
    await fixture.writeJson("package.json", {
      name: "zedbee",
      version: "0.1.0-beta.1",
    });
    const result = spawnSync(process.execPath, [script, "--tag-check"], {
      cwd: fixture.root,
      env: { ...process.env, GITHUB_REF: ref },
      encoding: "utf8",
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(status);
    if (status === 1) expect(result.stderr).toMatch(/tag.*version/iu);
    else expect(result.stdout).toContain("Release tag check passed");
  });
});
