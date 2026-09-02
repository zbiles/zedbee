import { beforeEach, describe, expect, it, vi } from "vitest";

const pathControl = vi.hoisted(() => ({
  canonicalPath: "/private/tmp/zedbee-snapshot-example",
  canonicalTemporaryRoot: "/private/tmp",
}));

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return {
    ...original,
    lstatSync: () => ({ isDirectory: () => true }),
    realpathSync: (path: string) =>
      path.includes("zedbee-snapshot-")
        ? pathControl.canonicalPath
        : pathControl.canonicalTemporaryRoot,
  };
});

vi.mock("node:os", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:os")>();
  return { ...original, tmpdir: () => "/tmp-alias" };
});

import { validateReportableSnapshotPath } from "../../src/git/snapshot-path.js";

describe("validateReportableSnapshotPath", () => {
  beforeEach(() => {
    pathControl.canonicalPath = "/private/tmp/zedbee-snapshot-example";
    pathControl.canonicalTemporaryRoot = "/private/tmp";
  });

  it("returns the canonical managed path when the input uses an OS alias", () => {
    expect(
      validateReportableSnapshotPath(
        "/tmp-alias/zedbee-snapshot-example",
      ),
    ).toBe("/private/tmp/zedbee-snapshot-example");
  });
});
