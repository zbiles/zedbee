import { symlink, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { inspectRepository } from "../../src/inspection/inspect-repository.js";
import { captureSnapshotRegistry } from "../../src/inspection/snapshot-registry.js";
import {
  canonicalizeSnapshotRoot,
  readContainedFile,
} from "../../src/inspection/read-json.js";
import { phaseFailure } from "../../src/scan/analysis-failure.js";
import { RepositoryInspectionError } from "../../src/inspection/types.js";
import { createInspectionFixture } from "./fixture.js";

const linkTypes = ["dangling", "external", "cycle"] as const;
async function linkFixture(path: string, kind: (typeof linkTypes)[number]) {
  const fixture = await createInspectionFixture();
  const outside = await createInspectionFixture();
  await fixture.writeJson("web/package.json", { name: "web" });
  await fixture.write("web/src/value.ts", "export const value = 1;\n");
  await outside.write("private", "outside contents must never be read");
  await mkdir(join(fixture.root, path, ".."), { recursive: true });
  const target =
    kind === "external"
      ? join(outside.root, "private")
      : kind === "cycle"
        ? join(fixture.root, path)
        : "missing-target";
  await symlink(target, join(fixture.root, path), "file");
  return { fixture, outside };
}

describe("unavailable snapshot symlinks", () => {
  it.each(linkTypes)(
    "ignores an unrelated %s runtime link outside independent projects",
    async (kind) => {
      const { fixture } = await linkFixture(
        "research/runtime/SingletonLock",
        kind,
      );
      const inspection = await inspectRepository(fixture.root);
      expect(
        inspection.workspaces.map(({ relativeRoot }) => relativeRoot),
      ).toEqual(["web"]);
      expect(inspection.workspaces[0]?.sourceFiles).toEqual([
        "web/src/value.ts",
      ]);
      const registry = await captureSnapshotRegistry(
        await canonicalizeSnapshotRoot(fixture.root),
      );
      await expect(
        readContainedFile(registry, "research/runtime/SingletonLock"),
      ).rejects.toMatchObject({
        code:
          kind === "external"
            ? "UNSAFE_SNAPSHOT_PATH"
            : "INVALID_SNAPSHOT_DATA",
      });
    },
  );

  it.each([
    "package.json",
    "pnpm-workspace.yaml",
    "tsconfig.json",
    "src/alias.ts",
    "web/assets/runtime",
    "web",
  ])(
    "keeps unavailable required input %s fatal and identifies the relative path",
    async (path) => {
      const actualPath = path === "web" ? "packages/alias" : path;
      const { fixture } = await linkFixture(actualPath, "dangling");
      if (path === "web")
        await fixture.writeJson("package.json", { workspaces: ["packages/*"] });
      await expect(inspectRepository(fixture.root)).rejects.toMatchObject({
        code: "INVALID_SNAPSHOT_DATA",
        path: actualPath,
        reason: "unresolved-symlink",
      });
    },
  );

  it("does not inventory an explicitly requested external link or its descendants", async () => {
    const { fixture } = await linkFixture(
      "research/runtime/SingletonSocket",
      "external",
    );
    const root = await canonicalizeSnapshotRoot(fixture.root);
    await expect(
      captureSnapshotRegistry(root, ["research/runtime/SingletonSocket"]),
    ).rejects.toMatchObject({ code: "UNSAFE_SNAPSHOT_PATH" });
    const registry = await captureSnapshotRegistry(root);
    expect(() =>
      registry.resolve("research/runtime/SingletonSocket/secret"),
    ).toThrow();
  });
});

describe("inspection link diagnostic boundary", () => {
  it.each(["/outside/private", "../escape", "bad\u001b[31m.ts"])(
    "does not expose an unsafe diagnosis path %s",
    (path) => {
      const error = new RepositoryInspectionError(
        "UNSAFE_SNAPSHOT_PATH",
        "private raw error",
        { path, reason: "external-symlink" },
      );
      expect(phaseFailure(error, "target-inspection", "index")).toEqual({
        code: "TARGET_INSPECTION_FAILED",
        message: "Zedbee could not inspect the staged snapshot.",
        remediation:
          "Check the staged repository metadata and run the scan again.",
      });
    },
  );
});

describe("workspace declarations and runtime names", () => {
  it("rejects an unavailable workspace selected only by root pnpm metadata", async () => {
    const { fixture } = await linkFixture("packages/missing", "dangling");
    await fixture.write(
      "pnpm-workspace.yaml",
      "packages:\n  - web\n  - packages/*\n",
    );
    await expect(inspectRepository(fixture.root)).rejects.toMatchObject({
      path: "packages/missing",
      reason: "unresolved-symlink",
    });
  });
  it.each(["constructor", "toString", "__proto__"])(
    "does not treat unrelated runtime/%s as a lockfile",
    async (name) => {
      const { fixture } = await linkFixture(`runtime/${name}`, "dangling");
      await expect(inspectRepository(fixture.root)).resolves.toMatchObject({
        workspaces: [expect.objectContaining({ relativeRoot: "web" })],
      });
    },
  );
});
