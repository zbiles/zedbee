import { describe, expect, it } from "vitest";
import {
  formatTemporaryReportMaxAge,
  parseTemporaryReportMaxAge,
} from "../../src/reporting/report-age.js";

describe("temporary report maximum age", () => {
  it.each([
    ["30m", 1_800_000, "30 minutes"],
    ["1h", 3_600_000, "1 hour"],
    ["24h", 86_400_000, "24 hours"],
    ["7d", 604_800_000, "7 days"],
  ] as const)("parses and describes %s", (value, milliseconds, description) => {
    expect(parseTemporaryReportMaxAge(value)).toBe(milliseconds);
    expect(formatTemporaryReportMaxAge(value)).toBe(description);
  });

  it.each(["", "0h", "1.5h", "24", "24H", " 24h", "9007199254740991d"])(
    "rejects invalid duration %j",
    (value) => {
      expect(() => parseTemporaryReportMaxAge(value)).toThrow(
        "Invalid temporary report maximum age",
      );
    },
  );
});
