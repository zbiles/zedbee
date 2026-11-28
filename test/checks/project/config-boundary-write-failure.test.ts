import { access, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { writeManagedJsonConfig } from "../../../src/checks/project/config-boundary.js";

// A write that never completes must not leave a temporary directory behind,
// and the original write error must be rethrown instead of surfacing a
// "contents changed" error. The config file is replaced with a symlink to a
// character device: the exclusive `wx` open succeeds, but `writeFile` on the
// handle throws, which is exactly the failed-write path.
const { realOpen } = await vi.hoisted(async () => {
  const actual =
    await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
  return { realOpen: actual.open };
});

vi.mock("node:fs/promises", async () => {
  const actual =
    await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
  return {
    ...actual,
    open: vi.fn(actual.open),
  };
});

const fsPromises = await import("node:fs/promises");
const sentinelDirs: string[] = [];

afterEach(async () => {
  vi.mocked(fsPromises.open).mockReset();
  await Promise.all(
    sentinelDirs
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

it("rethrows the write error and removes the temporary directory", async () => {
  const root = await fsPromises.realpath(await fsPromises.realpath(tmpdir()));
  const sentinelDir = await mkdtemp(join(root, "zedbee-write-failure-"));
  sentinelDirs.push(sentinelDir);
  const blockedTarget = join(sentinelDir, "not-a-file");
  if (process.platform === "win32") {
    await fsPromises.mkdir(blockedTarget);
  } else {
    await symlink("/dev/null", blockedTarget);
  }

  let recordedPath: string | undefined;
  const openSpy = vi.mocked(fsPromises.open);
  openSpy.mockImplementationOnce(async (path: unknown, ...rest: unknown[]) => {
    const handle = await realOpen(path as string, ...(rest as never[]));
    recordedPath = String(path);
    handle.writeFile = async () => {
      await handle.write("{");
      throw new Error("simulated disk full");
    };
    return handle;
  });

  // The temporary config is written under a fresh temporary directory; the
  // spy above only replaces the first `open` call, which is the production
  // code opening the config file inside its own temporary directory.
  await expect(writeManagedJsonConfig("knip", { a: 1 })).rejects.toThrow(
    "simulated disk full",
  );

  expect(recordedPath).toBeDefined();
  await expect(access(dirname(recordedPath!))).rejects.toMatchObject({
    code: "ENOENT",
  });
});
