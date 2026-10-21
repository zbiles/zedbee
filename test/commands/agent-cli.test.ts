import { describe, expect, it } from "vitest";
import { runCli } from "../../src/cli.js";

describe("agent workflow options", () => {
  it.each(["codex", "claude"] as const)(
    "forwards an approved %s installation without starting telemetry",
    async (install) => {
      let actual: unknown;
      const code = await runCli(
        ["node", "zedbee", "agent", "--install", install, "--yes"],
        {
          executeAgentCommand: async (options) => {
            actual = options;
            return 0;
          },
          startTelemetry: () => {
            throw new Error("agent instructions must not start telemetry");
          },
        },
      );
      expect(code).toBe(0);
      expect(actual).toEqual({ cwd: process.cwd(), install, yes: true });
    },
  );
});
