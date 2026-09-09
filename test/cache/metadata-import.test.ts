import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/config/schema.js", () => {
  throw new Error("engine-bearing config schema loaded");
});

describe("managed check metadata import boundary", () => {
  it("loads without evaluating engine-bearing configuration modules", async () => {
    await expect(import("../../src/checks/metadata.js")).resolves.toMatchObject(
      {
        CHECK_METADATA: expect.objectContaining({
          types: expect.objectContaining({
            observationInputs: "installed-dependencies",
          }),
        }),
      },
    );
  });
});
