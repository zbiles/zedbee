import { expect, it, vi } from "vitest";
import { ClientOwnership } from "../../src/service/client-ownership.js";
import type { StateLease } from "../../src/service/state.js";

const sessionId = "a".repeat(64);
const eventId = "b".repeat(64);

it("waits for an in-flight ownership handoff before proving and removing its lease after disconnect", async () => {
  let handoff!: (lease: StateLease) => void;
  let finishClose!: () => void;
  const handedOff = new Promise<StateLease>((resolve) => {
    handoff = resolve;
  });
  const closed = new Promise<void>((resolve) => {
    finishClose = resolve;
  });
  const acquire = vi.fn(() => true);
  const close = vi.fn(() => closed);
  const removeLease = vi.fn(async () => {});
  const acknowledge = vi.fn(async () => {});
  const lease = vi.fn(() => handedOff);
  const owner = new ClientOwnership(
    { lease, removeLease },
    acknowledge,
    () => false,
  );

  const accepting = owner.accept({ type: "io-acquire", eventId, sessionId });
  let completed = false;
  const closing = owner.close().then(() => {
    completed = true;
  });
  expect(lease).toHaveBeenCalledWith(sessionId, false);
  expect(acquire).not.toHaveBeenCalled();
  handoff({ acquire, close });
  await accepting;
  await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(acquire).toHaveBeenCalledOnce();
  expect(acknowledge).not.toHaveBeenCalled();
  expect(removeLease).not.toHaveBeenCalled();
  expect(completed).toBe(false);
  finishClose();
  await closing;
  expect(removeLease).toHaveBeenCalledExactlyOnceWith(sessionId);
});

it("does not remove a lease or acknowledge release if independent cleanup fails", async () => {
  const failure = new Error("OS handle could not close");
  const close = vi.fn(async () => {
    throw failure;
  });
  const removeLease = vi.fn(async () => {});
  const acknowledge = vi.fn(async () => {});
  const owner = new ClientOwnership(
    {
      lease: async () => ({ acquire: () => true, close }),
      removeLease,
    },
    acknowledge,
    () => true,
  );
  await owner.accept({ type: "io-acquire", eventId, sessionId });
  expect(acknowledge).toHaveBeenCalledExactlyOnceWith(eventId);
  await expect(
    owner.accept({ type: "io-release", eventId: "c".repeat(64), sessionId }),
  ).rejects.toBe(failure);
  expect(removeLease).not.toHaveBeenCalled();
  expect(acknowledge).toHaveBeenCalledOnce();
  await expect(owner.close()).rejects.toBe(failure);
  expect(close).toHaveBeenCalledTimes(2);
});
