import { describe, expect, it } from "vitest";
import {
  DEFAULT_GIT_OUTPUT_LIMIT_BYTES,
  resolveScanResourcePolicy,
} from "../../src/scan/resource-policy.js";

describe("resolveScanResourcePolicy", () => {
  it("uses an unbounded hard timeout and bounded Git output by default", () => {
    expect(resolveScanResourcePolicy({}, {})).toEqual({
      gitSoftTimeoutMs: undefined,
      gitHardTimeoutMs: undefined,
      gitOutputLimitBytes: DEFAULT_GIT_OUTPUT_LIMIT_BYTES,
    });
  });

  it.each([
    ["250ms", 250],
    ["30s", 30_000],
    ["2m", 120_000],
    ["1h", 3_600_000],
  ])("parses a configured hard timeout of %s", (hardTimeout, expected) => {
    expect(
      resolveScanResourcePolicy({ gitHardTimeout: hardTimeout }, {}),
    ).toMatchObject({ gitHardTimeoutMs: expected });
  });

  it("retains configured soft limits and output bounds", () => {
    expect(
      resolveScanResourcePolicy(
        {
          gitSoftTimeout: "5s",
          gitHardTimeout: "20s",
          gitOutputLimitBytes: 1024,
        },
        {},
      ),
    ).toEqual({
      gitSoftTimeoutMs: 5_000,
      gitHardTimeoutMs: 20_000,
      gitOutputLimitBytes: 1024,
    });
  });

  it.each([
    [{ gitHardTimeout: "0s" }],
    [{ gitHardTimeout: "2.5s" }],
    [{ gitHardTimeout: "25" }],
    [{ gitHardTimeout: "600h" }],
    [{ gitOutputLimitBytes: 0 }],
    [{ gitOutputLimitBytes: 1.5 }],
    [{ gitSoftTimeout: "30s", gitHardTimeout: "30s" }],
    [{ gitSoftTimeout: "30s", gitHardTimeout: "20s" }],
  ])("rejects an invalid resource policy", (configured) => {
    expect(() => resolveScanResourcePolicy(configured, {})).toThrow();
  });

  it("gives no-timeout precedence over CLI and configured hard timeouts", () => {
    expect(
      resolveScanResourcePolicy(
        { gitSoftTimeout: "5s", gitHardTimeout: "30s" },
        { timeout: "10s", noTimeout: true },
      ),
    ).toEqual({
      gitSoftTimeoutMs: 5_000,
      gitHardTimeoutMs: undefined,
      gitOutputLimitBytes: DEFAULT_GIT_OUTPUT_LIMIT_BYTES,
    });
  });

  it("lets the CLI timeout replace the configured hard timeout", () => {
    expect(
      resolveScanResourcePolicy(
        { gitHardTimeout: "30s" },
        { timeout: "10s" },
      ),
    ).toMatchObject({ gitHardTimeoutMs: 10_000 });
  });
});
