import { describe, expect, it } from "vitest";
import { scanTimeoutOverrides } from "../src/cli.js";
import { resolveScanResourcePolicy } from "../src/scan/resource-policy.js";

describe("scanTimeoutOverrides", () => {
  it.each([
    ["--timeout", "30s", "--no-timeout"],
    ["--no-timeout", "--timeout", "30s"],
  ])(
    "makes --no-timeout dominant when both flags are supplied: %s %s %s",
    (...flags) => {
      const overrides = scanTimeoutOverrides(
        ["node", "zedbee", "scan", ...flags],
        "30s",
      );

      expect(overrides).toEqual({ noTimeout: true });
      expect(
        resolveScanResourcePolicy(
          { gitHardTimeout: "60s" },
          overrides,
        ).gitHardTimeoutMs,
      ).toBeUndefined();
    },
  );

  it("keeps --timeout as the hard-timeout override when no-timeout is absent", () => {
    expect(
      scanTimeoutOverrides(["node", "zedbee", "scan", "--timeout", "30s"], "30s"),
    ).toEqual({ timeout: "30s" });
  });
});
