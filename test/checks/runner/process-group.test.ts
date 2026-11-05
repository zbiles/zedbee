import { afterEach, expect, it, vi } from "vitest";
import { stopProcessGroup } from "../../../src/checks/runner/process-group.js";

const inventory = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  const { promisify } = await import("node:util");
  const execFile = vi.fn();
  Object.defineProperty(execFile, promisify.custom, { value: inventory });
  return { ...original, execFile };
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  inventory.mockReset();
});

it("preserves permission denial when a live member remains in the group", async () => {
  const denied = Object.assign(new Error("kill EPERM"), { code: "EPERM" });
  vi.spyOn(process, "kill").mockImplementation(() => {
    throw denied;
  });
  inventory.mockResolvedValue({ stdout: "42 42 S\n43 42 Z\n" });
  await expect(stopProcessGroup(42)).rejects.toBe(denied);
});

it.each(["42 42 Z\n", "99 99 S\n"])(
  "keeps cleanup pending through EPERM until strict group absence: %s",
  async (stdout) => {
    const denied = Object.assign(new Error("kill EPERM"), { code: "EPERM" });
    let absent = false;
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw absent
        ? Object.assign(new Error("kill ESRCH"), { code: "ESRCH" })
        : denied;
    });
    inventory.mockResolvedValue({ stdout });
    let outcome = "pending";
    const stopped = stopProcessGroup(42).then(
      () => {
        outcome = "resolved";
      },
      () => {
        outcome = "rejected";
      },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    try {
      expect(outcome).toBe("pending");
    } finally {
      absent = true;
      await stopped;
    }
    expect(outcome).toBe("resolved");
  },
);

it("keeps forced termination pending when its group becomes zombies", async () => {
  vi.useFakeTimers();
  const denied = Object.assign(new Error("kill EPERM"), { code: "EPERM" });
  let absent = false;
  vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
    if (absent) throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
    if (signal === "SIGKILL") throw denied;
    return true;
  });
  inventory.mockResolvedValue({ stdout: "42 42 Z\n" });
  let outcome = "pending";
  const stopped = stopProcessGroup(42).then(
    () => {
      outcome = "resolved";
    },
    () => {
      outcome = "rejected";
    },
  );
  try {
    await vi.advanceTimersByTimeAsync(2_020);
    expect(outcome).toBe("pending");
  } finally {
    absent = true;
    await vi.advanceTimersByTimeAsync(20);
    await stopped;
  }
  expect(outcome).toBe("resolved");
});

it.each(["unparseable inventory\n", new Error("inventory failed")])(
  "retains the permission failure without authoritative inventory: %s",
  async (result) => {
    const denied = Object.assign(new Error("kill EPERM"), { code: "EPERM" });
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw denied;
    });
    if (typeof result === "string")
      inventory.mockResolvedValue({ stdout: result });
    else inventory.mockRejectedValue(result);
    await expect(stopProcessGroup(42)).rejects.toBe(denied);
  },
);
