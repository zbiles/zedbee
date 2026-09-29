import { afterEach, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeTelemetryCommand } from "../../src/commands/telemetry.js";
const roots: string[] = [];
afterEach(() =>
  roots.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true })),
);
it("status creates no state, opt-out survives enable overrides, and management produces valid JSON", () => {
  const root = mkdtempSync(join(tmpdir(), "telemetry-settings-"));
  roots.push(root);
  let out = "";
  const io = {
    writeStdout: (v: string) => {
      out = v;
    },
    writeStderr: () => {},
  };
  const env = { XDG_STATE_HOME: root };
  expect(executeTelemetryCommand("status", env, io, "json")).toBe(0);
  expect(JSON.parse(out)).toMatchObject({
    enabled: true,
    installationId: null,
  });
  expect(existsSync(join(root, "zedbee"))).toBe(false);
  executeTelemetryCommand("disable", env, io, "json");
  expect(JSON.parse(out).enabled).toBe(false);
  executeTelemetryCommand("enable", { ...env, DO_NOT_TRACK: "1" }, io, "json");
  expect(JSON.parse(out)).toMatchObject({
    enabled: false,
    reason: "environment_override",
  });
  executeTelemetryCommand("status", env, io, "json");
  expect(JSON.parse(out).enabled).toBe(true);
});
