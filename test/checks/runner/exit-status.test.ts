import { expect, it } from "vitest";
import { workerExitedAbnormally } from "../../../src/checks/runner/exit-status.js";

it("accepts only the requested native Job Object termination status on Windows", () => {
  for (const code of [1, 7]) {
    expect(
      workerExitedAbnormally(
        { code, signal: null },
        {
          platform: "win32",
          requested: true,
        },
      ),
    ).toBe(true);
  }
  expect(
    workerExitedAbnormally(
      { code: 0x5a454442, signal: null },
      {
        platform: "win32",
        requested: true,
      },
    ),
  ).toBe(false);
  expect(
    workerExitedAbnormally(
      { code: 0x5a454442, signal: null },
      {
        platform: "win32",
        requested: false,
      },
    ),
  ).toBe(true);
});

it("recognizes only requested POSIX termination signals", () => {
  expect(
    workerExitedAbnormally(
      { code: null, signal: "SIGTERM" },
      {
        platform: "darwin",
        requested: true,
      },
    ),
  ).toBe(false);
  expect(
    workerExitedAbnormally(
      { code: null, signal: "SIGTERM" },
      {
        platform: "darwin",
        requested: false,
      },
    ),
  ).toBe(true);
  expect(
    workerExitedAbnormally(
      { code: null, signal: "SIGSEGV" },
      {
        platform: "darwin",
        requested: true,
      },
    ),
  ).toBe(true);
});
