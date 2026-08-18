import { describe, expect, it } from "vitest";
import {
  canonicalizeSnapshotRoot,
  readContainedFile,
  readContainedLines,
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

  it("collects late requested lines without retaining oversized prefixes", async () => {
    const fixture = await createInspectionFixture();
    await fixture.write(
      "large.txt",
      `${"x".repeat(2_000_000)}\nsecond\rthird\r\nfour\u2028five\u2029six`,
    );
    const registry = await captureSnapshotRegistry(
      await canonicalizeSnapshotRoot(fixture.root),
    );

    await expect(
      readContainedLines(registry, "large.txt", [2, 4, 6], {
        maxCodePoints: 501,
      }),
    ).resolves.toEqual(
      new Map([
        [2, "second"],
        [4, "four"],
        [6, "six"],
      ]),
    );
  });

  it("caps retained line code points and decodes characters split across chunks", async () => {
    const fixture = await createInspectionFixture();
    const splitLine = `${"a".repeat(65_535)}🙂`;
    await fixture.write("unicode.txt", `${splitLine}\nabcdefgh\n`);
    const registry = await captureSnapshotRegistry(
      await canonicalizeSnapshotRoot(fixture.root),
    );

    await expect(
      readContainedLines(registry, "unicode.txt", [1, 2], {
        maxCodePoints: 70_000,
      }),
    ).resolves.toEqual(
      new Map([
        [1, splitLine],
        [2, "abcdefgh"],
      ]),
    );
    await expect(
      readContainedLines(registry, "unicode.txt", [2], {
        maxCodePoints: 5,
      }),
    ).resolves.toEqual(new Map([[2, "abcde"]]));
  });

  it("rejects invalid requested lines and code-point limits", async () => {
    const fixture = await createInspectionFixture();
    await fixture.write("value.txt", "value\n");
    const registry = await captureSnapshotRegistry(
      await canonicalizeSnapshotRoot(fixture.root),
    );

    await expect(
      readContainedLines(registry, "value.txt", [0], { maxCodePoints: 10 }),
    ).rejects.toThrow(/positive safe line numbers/u);
    await expect(
      readContainedLines(registry, "value.txt", [1], { maxCodePoints: -1 }),
    ).rejects.toThrow(/non-negative safe code-point limit/u);
  });
});
