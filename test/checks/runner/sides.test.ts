import { expect, it } from "vitest";
import { settleSnapshotSides } from "../../../src/checks/settle-snapshot-sides.js";

it("finishes a heavy baseline before constructing the target analysis", async () => {
  const order: string[] = [];
  const result = await settleSnapshotSides(
    async () => {
      order.push("baseline-start");
      await Promise.resolve();
      order.push("baseline-end");
      return 1;
    },
    async () => {
      order.push("target-start");
      return 2;
    },
    new AbortController().signal,
  );
  expect(order).toEqual(["baseline-start", "baseline-end", "target-start"]);
  expect(result).toEqual([1, 2]);
});
