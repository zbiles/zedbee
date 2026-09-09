import { expect, it, vi } from "vitest";
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, unlink: vi.fn(actual.unlink) };
});
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ServiceState } from "../../src/service/state.js";

it.each([
  ["EPERM", "unlink", "target", true, "win32"],
  ["EACCES", "unlink", "target", true, "win32"],
  ["EBUSY", "unlink", "target", true, "win32"],
  ["EBUSY", "open", "target", false, "win32"],
  ["EBUSY", "unlink", "other", false, "win32"],
  ["EIO", "unlink", "target", false, "win32"],
  ["EBUSY", "unlink", "target", false, "linux"],
] as const)(
  "classifies only verified Windows unlink deferral (%s/%s/%s)",
  async (code, syscall, target, deferred, simulatedPlatform) => {
    const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "zl-")));
    const state = new ServiceState(join(root, "s"));
    await state.prepare();
    const id = "e".repeat(64),
      path = join(state.directory, `io-${id}.lock`);
    const lease = await state.lease(id);
    await lease.close();
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    const failure = Object.assign(new Error("Native unlink failure"), {
      code,
      syscall,
      path: target === "target" ? path : join(root, "other"),
    });
    vi.mocked(fs.unlink).mockImplementationOnce(async (actualPath) => {
      expect(actualPath).toBe(path);
      // Preserve real ownership/open/identity checks on the host. Only the
      // final native unlink result is modeled as Windows for portable coverage.
      Object.defineProperty(process, "platform", {
        ...platform,
        value: simulatedPlatform,
      });
      throw failure;
    });
    try {
      const outcome = await state.removeLease(id).catch((error) => error);
      if (deferred)
        expect(outcome).toMatchObject({ name: "LeaseRemovalDeferredError" });
      else expect(outcome).toBe(failure);
    } finally {
      Object.defineProperty(process, "platform", platform);
      vi.mocked(fs.unlink).mockRestore();
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);

it("does not classify an EBUSY verification failure as unlink deferral", async () => {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "zl-")));
  const state = new ServiceState(join(root, "s"));
  await state.prepare();
  const id = "d".repeat(64),
    path = join(state.directory, `io-${id}.lock`);
  const lease = await state.lease(id);
  await lease.close();
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const failure = Object.assign(new Error("Verification failed"), {
    code: "EBUSY",
    syscall: "unlink",
    path,
  });
  const original = (state as any).checkedFile.bind(state);
  const check = vi
    .spyOn(state as any, "checkedFile")
    .mockImplementation(async (...args) => {
      if (args[0] !== path) return original(...args);
      Object.defineProperty(process, "platform", {
        ...platform,
        value: "win32",
      });
      throw failure;
    });
  try {
    await expect(state.removeLease(id)).rejects.toBe(failure);
  } finally {
    Object.defineProperty(process, "platform", platform);
    check.mockRestore();
    await fs.rm(root, { recursive: true, force: true });
  }
});
