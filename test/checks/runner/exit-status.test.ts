import { expect, it } from "vitest";
import { workerExitedAbnormally } from "../../../src/checks/runner/exit-status.js";

it("recognizes Windows exit1 only with a requested and successful taskkill", () => {
  const exit = { code: 1, signal: null };
  expect(
    workerExitedAbnormally(exit, {
      platform: "win32",
      requested: true,
      windowsKiller: { code: 0, signal: null },
    }),
  ).toBe(false);
  expect(
    workerExitedAbnormally(exit, {
      platform: "win32",
      requested: false,
      windowsKiller: { code: 0, signal: null },
    }),
  ).toBe(true);
  expect(
    workerExitedAbnormally(exit, { platform: "win32", requested: true }),
  ).toBe(true);
  expect(
    workerExitedAbnormally(exit, {
      platform: "win32",
      requested: true,
      windowsKiller: { code: 128, signal: null },
    }),
  ).toBe(true);
  expect(
    workerExitedAbnormally(exit, {
      platform: "win32",
      requested: true,
      windowsKiller: { code: null, signal: "SIGTERM" },
    }),
  ).toBe(true);
});

it("preserves real nonzero crashes even when taskkill succeeds", () => {
  expect(
    workerExitedAbnormally(
      { code: 7, signal: null },
      {
        platform: "win32",
        requested: true,
        windowsKiller: { code: 0, signal: null },
      },
    ),
  ).toBe(true);
  expect(
    workerExitedAbnormally(
      { code: 1, signal: null },
      {
        platform: "darwin",
        requested: true,
        windowsKiller: { code: 0, signal: null },
      },
    ),
  ).toBe(true);
});

it("recognizes only requested POSIX termination signals", () => {
  expect(
    workerExitedAbnormally(
      { code: null, signal: "SIGTERM" },
      { platform: "darwin", requested: true },
    ),
  ).toBe(false);
  expect(
    workerExitedAbnormally(
      { code: null, signal: "SIGTERM" },
      { platform: "darwin", requested: false },
    ),
  ).toBe(true);
  expect(
    workerExitedAbnormally(
      { code: null, signal: "SIGSEGV" },
      { platform: "darwin", requested: true },
    ),
  ).toBe(true);
});
