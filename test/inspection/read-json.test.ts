import { describe, expect, it } from "vitest";
import {
  canonicalizeSnapshotRoot,
  readContainedFile,
} from "../../src/inspection/read-json.js";
import { captureSnapshotRegistry } from "../../src/inspection/snapshot-registry.js";
import { createInspectionFixture } from "./fixture.js";

describe("readContainedFile", () => {
  it("rejects a file that exceeds the requested byte limit", async () => {
    const fixture = await createInspectionFixture();
    await fixture.write("large.txt", "12345");
    const registry = await captureSnapshotRegistry(
      await canonicalizeSnapshotRoot(fixture.root),
    );

    await expect(
      readContainedFile(registry, "large.txt", { maxBytes: 4 }),
    ).rejects.toMatchObject({
      code: "FILE_SIZE_LIMIT_EXCEEDED",
      path: "large.txt",
      maxBytes: 4,
    });
  });

  it("reads a file whose byte size exactly matches the limit", async () => {
    const fixture = await createInspectionFixture();
    await fixture.write("exact.txt", "12345");
    const registry = await captureSnapshotRegistry(
      await canonicalizeSnapshotRoot(fixture.root),
    );

    await expect(
      readContainedFile(registry, "exact.txt", { maxBytes: 5 }),
    ).resolves.toBe("12345");
  });
});
