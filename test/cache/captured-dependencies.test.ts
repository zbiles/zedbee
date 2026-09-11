import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { unlink, writeFile } from "node:fs/promises";
import {
  CapturedDependencies,
  validateDependencyInputs,
} from "../../src/cache/captured-dependencies.js";
import {
  DEPENDENCY_LIMITS,
  sanitizeDependencyInputManifest,
} from "../../src/cache/dependency-inputs.js";
import { createInspectionFixture } from "../inspection/fixture.js";

describe("captured dependency view", () => {
  it("captures nested installations and invalidates reuse when their declarations change", async () => {
    const live = await createInspectionFixture();
    const file = "web/node_modules/example/index.d.ts";
    await live.write(file, "export const value: number;");
    const view = new CapturedDependencies({ repositoryRoot: live.root });
    expect(view.packageFileExists(join(live.root, file))).toBe(true);
    expect(view.readFile(join(live.root, file))).toBe(
      "export const value: number;",
    );
    const manifest = view.manifest();
    expect(manifest).toBeDefined();
    expect(
      validateDependencyInputs(manifest, { repositoryRoot: live.root }),
    ).toBe(true);
    await live.write(file, "export const value: string;");
    expect(
      validateDependencyInputs(manifest, { repositoryRoot: live.root }),
    ).toBe(false);
  });

  it("does not follow nested package links into working-copy source or outside the repository", async () => {
    const live = await createInspectionFixture();
    const outside = await createInspectionFixture();
    await live.write("web/source.d.ts", "export const secret: string;");
    await outside.write(
      "node_modules/example/index.d.ts",
      "export const secret: string;",
    );
    await live.symlink(
      "../../source.d.ts",
      "web/node_modules/example/index.d.ts",
    );
    await live.symlink(
      join(outside.root, "node_modules/example"),
      "web/node_modules/external",
    );
    const view = new CapturedDependencies({ repositoryRoot: live.root });
    expect(view.fileExists(join(live.root, "web/source.d.ts"))).toBe(false);
    expect(
      view.fileExists(join(live.root, "web/node_modules/example/index.d.ts")),
    ).toBe(false);
    expect(
      view.fileExists(join(live.root, "web/node_modules/external/index.d.ts")),
    ).toBe(false);
  });

  it("keeps nested installed dependencies unavailable to snapshot-only readers", async () => {
    const live = await createInspectionFixture();
    await live.write(
      "web/node_modules/example/index.d.ts",
      "export const value: number;",
    );
    const view = new CapturedDependencies({ repositoryRoot: live.root }, true);
    expect(
      view.fileExists(join(live.root, "web/node_modules/example/index.d.ts")),
    ).toBe(false);
  });

  it("serves the first captured bytes and rejects mutation before storage", async () => {
    const live = await createInspectionFixture();
    await live.write("node_modules/x/index.d.ts", "export const x: number;");
    const view = new CapturedDependencies({ repositoryRoot: live.root });
    const path = join(live.root, "node_modules/x/index.d.ts");
    expect(view.fileExists(path)).toBe(true);
    await live.write("node_modules/x/index.d.ts", "export const x: string;");
    expect(view.readFile(path)).toBe("export const x: number;");
    expect(
      validateDependencyInputs(view.manifest(), { repositoryRoot: live.root }),
    ).toBe(false);
  });

  it("revalidates live inputs even when called on the collecting view", async () => {
    const live = await createInspectionFixture();
    await live.write("node_modules/x/index.d.ts", "export const x: number;");
    const view = new CapturedDependencies({ repositoryRoot: live.root });
    const path = join(live.root, "node_modules/x/index.d.ts");
    view.readFile(path);
    const manifest = view.manifest()!;
    await live.write("node_modules/x/index.d.ts", "export const x: string;");
    expect(view.validate(manifest)).toBe(false);
    expect(view.readFile(path)).toBe("export const x: number;");
  });

  it("keeps missing probes and directory listings immutable", async () => {
    const live = await createInspectionFixture();
    await live.write("node_modules/@types/first/index.d.ts", "export {};");
    const view = new CapturedDependencies({ repositoryRoot: live.root });
    const path = join(live.root, "node_modules/new/index.d.ts");
    const directory = join(live.root, "node_modules/@types");
    expect(view.fileExists(path)).toBe(false);
    expect(view.getDirectories(directory)).toEqual(["first"]);
    await live.write("node_modules/new/index.d.ts", "export {};");
    await live.write("node_modules/@types/second/index.d.ts", "export {};");
    expect(view.fileExists(path)).toBe(false);
    expect(view.getDirectories(directory)).toEqual(["first"]);
    expect(
      validateDependencyInputs(view.manifest(), { repositoryRoot: live.root }),
    ).toBe(false);
  });

  it("captures symlink targets and never calls a present denied file missing", async () => {
    const live = await createInspectionFixture();
    await live.write("node_modules/a/index.d.ts", "export const x: number;");
    await live.write("node_modules/b/index.d.ts", "export const x: string;");
    await live.symlink("a", "node_modules/linked");
    await live.write("outside.d.ts", "private source");
    await live.symlink("../outside.d.ts", "node_modules/denied.d.ts");
    const view = new CapturedDependencies({ repositoryRoot: live.root });
    expect(
      view.readFile(join(live.root, "node_modules/linked/index.d.ts")),
    ).toBe("export const x: number;");
    expect(view.fileExists(join(live.root, "node_modules/denied.d.ts"))).toBe(
      false,
    );
    const manifest = view.manifest()!;
    expect(manifest.probes).toContainEqual(
      expect.objectContaining({
        kind: "entry",
        path: "packages:denied.d.ts",
        entryType: "denied",
      }),
    );
    expect(
      validateDependencyInputs(manifest, { repositoryRoot: live.root }),
    ).toBe(true);
    await unlink(join(live.root, "node_modules/linked"));
    await live.symlink("b", "node_modules/linked");
    expect(
      validateDependencyInputs(manifest, { repositoryRoot: live.root }),
    ).toBe(false);
  });

  it.each(["utf16le", "utf16be", "utf8-bom"])(
    "preserves %s compiler decoding and validates served bytes",
    async (encoding) => {
      const live = await createInspectionFixture();
      await live.write("node_modules/x/index.d.ts", "");
      const path = join(live.root, "node_modules/x/index.d.ts");
      await writeFile(
        path,
        encoding === "utf8-bom"
          ? Buffer.from("\uFEFFexport const x: number;", "utf8")
          : Buffer.concat([
              Buffer.from(encoding === "utf16le" ? [255, 254] : [254, 255]),
              encoding === "utf16le"
                ? Buffer.from("export const x: number;", "utf16le")
                : Buffer.from("export const x: number;", "utf16le").swap16(),
            ]),
      );
      const view = new CapturedDependencies({ repositoryRoot: live.root });
      expect(view.readFile(path)).toBe("export const x: number;");
      expect(
        validateDependencyInputs(view.manifest(), {
          repositoryRoot: live.root,
        }),
      ).toBe(true);
      await writeFile(path, "export const x: string;");
      expect(
        validateDependencyInputs(view.manifest(), {
          repositoryRoot: live.root,
        }),
      ).toBe(false);
    },
  );

  it("bypasses retention for oversized dependencies without hiding them from the engine", async () => {
    const live = await createInspectionFixture();
    const source = " ".repeat(DEPENDENCY_LIMITS.fileBytes + 1);
    await live.write("node_modules/x/index.d.ts", source);
    const view = new CapturedDependencies({ repositoryRoot: live.root });
    const path = join(live.root, "node_modules/x/index.d.ts");
    expect(view.fileExists(path)).toBe(true);
    expect(view.readFile(path)).toBe(source);
    expect(view.manifest()).toBeUndefined();
  });

  it.each([
    { kind: "missing", path: "/etc/passwd" },
    { kind: "missing", path: "repository:../secret" },
    { kind: "missing", path: "packages:../x/../../secret" },
    { kind: "missing", path: "packages:x", source: "secret" },
    {
      kind: "file",
      path: "packages:x",
      realPath: "repository:secret",
      digest: "a".repeat(64),
    },
  ])("rejects malformed or escaping private metadata: %j", (probe) => {
    expect(() =>
      sanitizeDependencyInputManifest({
        version: 1,
        roots: "a".repeat(64),
        probes: [probe],
      }),
    ).toThrow();
  });

  it("rejects oversized manifests and duplicated probes", () => {
    const probe = { kind: "missing", path: "packages:missing.d.ts" };
    expect(() =>
      sanitizeDependencyInputManifest({
        version: 1,
        roots: "a".repeat(64),
        probes: [probe, probe],
      }),
    ).toThrow();
    expect(() =>
      sanitizeDependencyInputManifest({
        version: 1,
        roots: "a".repeat(64),
        probes: Array.from(
          { length: DEPENDENCY_LIMITS.probes + 1 },
          (_, index) => ({ kind: "missing", path: `packages:${index}.d.ts` }),
        ),
      }),
    ).toThrow();
    expect(() =>
      sanitizeDependencyInputManifest({
        version: 1,
        roots: "a".repeat(64),
        probes: Array.from({ length: 1600 }, (_, index) => ({
          kind: "missing",
          path: `packages:${"x".repeat(3000)}${index}.d.ts`,
        })),
      }),
    ).toThrow();
  });

  it("distinguishes legitimate double-dot names from parent traversal", async () => {
    const live = await createInspectionFixture();
    await live.write("node_modules/x/index..d.ts", "export {};");
    const view = new CapturedDependencies({ repositoryRoot: live.root });
    view.readFile(join(live.root, "node_modules/x/index..d.ts"));
    expect(
      validateDependencyInputs(view.manifest(), { repositoryRoot: live.root }),
    ).toBe(true);
  });

  it("bypasses cache when a file changes during its descriptor read", async () => {
    const live = await createInspectionFixture();
    await live.write("node_modules/x/index.d.ts", "export const x: number;");
    const path = join(live.root, "node_modules/x/index.d.ts");
    const view = new CapturedDependencies({ repositoryRoot: live.root });
    const originalRead = fs.readSync;
    const read = vi
      .spyOn(fs, "readSync")
      .mockImplementation((...args: unknown[]) => {
        const result = Reflect.apply(originalRead, fs, args);
        fs.writeFileSync(path, "export const x: string;");
        return result;
      });
    syncBuiltinESMExports();
    try {
      expect(view.readFile(path)).toBe("export const x: number;");
      expect(view.manifest()).toBeUndefined();
    } finally {
      read.mockRestore();
      syncBuiltinESMExports();
    }
  });

  it("preserves file existence when bytes cannot be captured", async () => {
    const live = await createInspectionFixture();
    await live.write("node_modules/x/index.d.ts", "export {};");
    const path = join(live.root, "node_modules/x/index.d.ts");
    const view = new CapturedDependencies({ repositoryRoot: live.root });
    const open = vi.spyOn(fs, "openSync").mockImplementation(() => {
      throw Object.assign(new Error("denied"), { code: "EACCES" });
    });
    syncBuiltinESMExports();
    try {
      expect(view.fileExists(path)).toBe(true);
      expect(view.readFile(path)).toBeUndefined();
      expect(view.manifest()).toBeUndefined();
    } finally {
      open.mockRestore();
      syncBuiltinESMExports();
    }
  });

  it("does not turn an ambient-directory read failure into an empty type list", async () => {
    const live = await createInspectionFixture();
    await live.write("node_modules/@types/x/index.d.ts", "export {};");
    const view = new CapturedDependencies({ repositoryRoot: live.root });
    const readdir = vi.spyOn(fs, "readdirSync").mockImplementation(() => {
      throw Object.assign(new Error("denied"), { code: "EACCES" });
    });
    syncBuiltinESMExports();
    try {
      expect(() =>
        view.directoryEntries(join(live.root, "node_modules/@types")),
      ).toThrow();
      expect(
        view.getDirectories(join(live.root, "node_modules/@types")),
      ).toEqual([]);
      expect(view.manifest()).toBeUndefined();
    } finally {
      readdir.mockRestore();
      syncBuiltinESMExports();
    }
  });

  it("preserves allowed external aliases when their scope requires bypassing cache", async () => {
    const live = await createInspectionFixture();
    const external = await createInspectionFixture();
    await live.write("node_modules/x/index.d.ts", "export const x: number;");
    await external.symlink(
      join(live.root, "node_modules/x/index.d.ts"),
      "alias.d.ts",
    );
    const view = new CapturedDependencies({ repositoryRoot: live.root });
    expect(view.directoryExists(live.root)).toBe(true);
    expect(view.readFile(join(external.root, "alias.d.ts"))).toBe(
      "export const x: number;",
    );
    expect(view.manifest()).toBeUndefined();
  });

  it("does not erase an outside directory alias from the input identity", async () => {
    const live = await createInspectionFixture();
    const external = await createInspectionFixture();
    await live.write("node_modules/x/index.d.ts", "export const x: number;");
    await external.symlink(join(live.root, "node_modules/x"), "alias");
    const view = new CapturedDependencies({ repositoryRoot: live.root });
    expect(view.readFile(join(external.root, "alias/index.d.ts"))).toBe(
      "export const x: number;",
    );
    expect(view.manifest()).toBeUndefined();
  });

  it("does not hide a present file where ambient types require a directory", async () => {
    const live = await createInspectionFixture();
    await live.write("node_modules/@types", "not a directory");
    const view = new CapturedDependencies({ repositoryRoot: live.root });
    expect(() =>
      view.directoryEntries(join(live.root, "node_modules/@types")),
    ).toThrow();
  });

  it("does not serve an outside file swapped in between containment and open", async () => {
    const live = await createInspectionFixture();
    const external = await createInspectionFixture();
    await live.write("node_modules/x/index.d.ts", "export const x: number;");
    await external.write("private.d.ts", "private-outside-source");
    const path = join(live.root, "node_modules/x/index.d.ts");
    const view = new CapturedDependencies({ repositoryRoot: live.root });
    const originalOpen = fs.openSync;
    const open = vi
      .spyOn(fs, "openSync")
      .mockImplementation((...args: unknown[]) => {
        fs.unlinkSync(path);
        fs.symlinkSync(join(external.root, "private.d.ts"), path, "file");
        return Reflect.apply(originalOpen, fs, args);
      });
    syncBuiltinESMExports();
    try {
      expect(view.readFile(path)).toBeUndefined();
      expect(view.manifest()).toBeUndefined();
    } finally {
      open.mockRestore();
      syncBuiltinESMExports();
    }
  });
});
