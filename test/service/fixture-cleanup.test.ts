import { expect, it } from "vitest";
import { lstat, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ServiceState } from "../../src/service/state.js";
import { removeServiceFixture } from "./fixture-cleanup.js";

it("retains an unavailable fixture until its existing kernel ownership is independently free", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "zf-")));
  const state = new ServiceState(join(root, "s"));
  await state.prepare();
  const release = (await state.lock())!;
  try {
    await expect(
      removeServiceFixture(root, { state: "unavailable" }),
    ).rejects.toThrow("still owns");
    await expect(lstat(root)).resolves.toBeDefined();
    await release();
    await removeServiceFixture(root, { state: "unavailable" });
    await expect(lstat(root)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await release();
    await rm(root, { recursive: true, force: true });
  }
});
it("retains an unavailable fixture when startup ownership is corrupt", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "zf-")));
  const state = new ServiceState(join(root, "s"));
  await state.prepare();
  const lease = await state.lease();
  await lease.close();
  try {
    await writeFile(join(state.directory, "owner.lock"), "corrupt");
    await expect(
      removeServiceFixture(root, { state: "unavailable" }),
    ).rejects.toThrow();
    await expect(lstat(root)).resolves.toBeDefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
