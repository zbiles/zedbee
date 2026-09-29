import { expect, it } from "vitest";
import { ProjectProcessOwner } from "../../../src/checks/prettier/project-process.js";
import type { WindowsJob } from "../../../src/checks/runner/windows-job.js";

it("retains the Windows job until every descendant exits", async () => {
  const events: string[] = [];
  let remaining = 2;
  const job: WindowsJob = {
    assign(pid) {
      events.push(`assign:${pid}`);
    },
    terminate() {
      events.push("terminate");
    },
    activeProcesses() {
      return remaining--;
    },
    close() {
      events.push("close");
    },
  };
  const owner = new ProjectProcessOwner(job);
  owner.assign(123);
  const pending = owner.stop();
  expect(events).toEqual(["assign:123", "terminate"]);
  await pending;
  expect(events).toEqual(["assign:123", "terminate", "close"]);
});

it("does not release ownership when native termination fails", async () => {
  let closed = false;
  const owner = new ProjectProcessOwner({
    assign() {},
    terminate() {
      throw new Error("OS refused cleanup");
    },
    activeProcesses() {
      return 1;
    },
    close() {
      closed = true;
    },
  });
  owner.assign(123);
  await expect(owner.stop()).rejects.toThrow("OS refused cleanup");
  expect(closed).toBe(false);
});
