import { describe, expect, it } from "vitest";
import { renderJson } from "../../src/renderers/json.js";
import { createReport } from "../helpers/scan-report.js";

describe("agent JSON", () => {
  it("is byte-for-byte deterministic, versioned, and ANSI-free", () => {
    const report = createReport();
    const first = renderJson(report);
    const second = renderJson(report);

    expect(first).toBe(second);
    expect(JSON.parse(first)).toMatchObject({
      schemaVersion: 1,
      target: "index",
    });
    expect(first).not.toMatch(/\u001B\[[0-9;]*m/u);
  });
});
