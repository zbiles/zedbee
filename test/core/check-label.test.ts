import { describe, expect, it } from "vitest";

import { checkLabel } from "../../src/core/check-label.js";

describe("checkLabel", () => {
  it("returns the label for a known check", () => {
    expect(checkLabel("lint")).toBe("Lint");
  });

  it("returns the id for an unknown check", () => {
    expect(checkLabel("unknownCheck")).toBe("unknownCheck");
  });

  it("returns 'toString' for toString", () => {
    expect(checkLabel("toString")).toBe("toString");
  });

  it("returns 'constructor' for constructor", () => {
    expect(checkLabel("constructor")).toBe("constructor");
  });
});
