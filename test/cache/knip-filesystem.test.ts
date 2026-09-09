import { describe, expect, it } from "vitest";
import { readFile, realpath, stat, unlink, utimes } from "node:fs/promises";
import { join } from "node:path";
import { createInspectionFixture } from "../inspection/fixture.js";
import { createKnipFilesystem } from "../../src/checks/dead-code/captured-filesystem.js";
import { CapturedDependencies } from "../../src/cache/captured-dependencies.js";
import {
  captureAnalysisSources,
  withAnalysisSourceCapture,
} from "../../src/inspection/source-capture.js";

describe("Knip's shared captured filesystem", () => {
  it("marks a swallowed oversized-read error as incomplete", async () => {
    const root = await createInspectionFixture();
    await root.write("large.ts", "x".repeat(8 * 1024 * 1024 + 1));
    const canonical = await realpath(root.root);
    const context = {
      repositoryRoot: root.root,
      snapshots: { baselineDir: canonical, targetDir: canonical },
    };
    const view = await createKnipFilesystem(context, canonical, {});
    try {
      expect(() => view.fs.readFileSync("/snapshot/large.ts")).toThrow();
      expect(() => view.assertComplete()).toThrow();
      expect(view.capture.manifest()).toBeUndefined();
    } finally {
      view.close();
    }
  });
  it("freezes consumed source bytes and denies outside/installed bytes", async () => {
    const root = await createInspectionFixture();
    const outside = await createInspectionFixture();
    await root.write("src/file.ts", "export const oldValue = 1;");
    await root.write("node_modules/denied/index.js", "HOST_DEPENDENCY");
    await outside.write("sentinel.ts", "HOST_SENTINEL");
    const canonical = await realpath(root.root);
    const context = {
      repositoryRoot: root.root,
      snapshots: { baselineDir: canonical, targetDir: canonical },
    };
    const view = await createKnipFilesystem(context, canonical, {});
    try {
      expect(view.fs.readFileSync("/snapshot/src/file.ts", "utf8")).toBe(
        "export const oldValue = 1;",
      );
      const before = await stat(join(root.root, "src/file.ts"));
      await root.write("src/file.ts", "export const newValue = 2;");
      await utimes(join(root.root, "src/file.ts"), before.atime, before.mtime);
      expect(view.fs.readFileSync("/snapshot/src/file.ts", "utf8")).toBe(
        "export const oldValue = 1;",
      );
      expect(
        CapturedDependencies.validate(view.capture.manifest()!, context, true),
      ).toBe(false);
      expect(() =>
        view.fs.readFileSync(join(outside.root, "sentinel.ts")),
      ).toThrow();
      expect(() =>
        view.fs.readFileSync("/snapshot/node_modules/denied/index.js"),
      ).toThrow();
      expect(() =>
        view.fs.writeFileSync("/snapshot/src/file.ts", "replace"),
      ).toThrow();
      expect(await readFile(join(root.root, "src/file.ts"), "utf8")).toBe(
        "export const newValue = 2;",
      );
    } finally {
      view.close();
    }
    expect(() => view.fs.readFileSync("/snapshot/src/file.ts")).toThrow();
  });

  it("rejects a symlink retargeted after inventory and before its first read", async () => {
    const root = await createInspectionFixture();
    await root.write("src/a.ts", "export const a = 1;");
    await root.write("src/b.ts", "export const b = 1;");
    await root.symlink("a.ts", "src/link.ts");
    const canonical = await realpath(root.root);
    const context = {
      repositoryRoot: root.root,
      snapshots: { baselineDir: canonical, targetDir: canonical },
    };
    const view = await createKnipFilesystem(context, canonical, {});
    try {
      await unlink(join(root.root, "src/link.ts"));
      await root.symlink("b.ts", "src/link.ts");
      expect(() =>
        view.fs.readFileSync("/snapshot/src/link.ts", "utf8"),
      ).toThrow();
    } finally {
      view.close();
    }
  });

  it("uses the session's captured bytes but validates metadata against fresh disk", async () => {
    const root = await createInspectionFixture();
    await root.write("src/file.ts", "export const original = 1;");
    const source = await captureAnalysisSources([
      { snapshotRoot: root.root, paths: ["src/file.ts"] },
    ]);
    expect(source).toBeDefined();
    const canonical = await realpath(root.root);
    const context = {
      repositoryRoot: root.root,
      snapshots: { baselineDir: canonical, targetDir: canonical },
    };
    try {
      await root.write("src/file.ts", "export const changed = 2;");
      await withAnalysisSourceCapture(source!, async () => {
        const view = await createKnipFilesystem(context, canonical, {});
        try {
          expect(view.fs.readFileSync("/snapshot/src/file.ts", "utf8")).toBe(
            "export const original = 1;",
          );
          expect(
            CapturedDependencies.validate(
              view.capture.manifest()!,
              context,
              true,
            ),
          ).toBe(false);
        } finally {
          view.close();
        }
      });
    } finally {
      await source!.close();
    }
  });
});
