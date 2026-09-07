import { expect, it } from "vitest";
import { waitForAssertion } from "./wait-for-assertion.js";

it("waits for the assertion to succeed without dropping its result", async () => {
  let attempts = 0;
  const result = await waitForAssertion(async () => {
    attempts += 1;
    expect(attempts).toBeGreaterThanOrEqual(3);
    return "ready";
  });
  expect(result).toBe("ready");
  expect(attempts).toBe(3);
});

it("does not treat a canceled wait as a successful assertion", async () => {
  const controller = new AbortController();
  await expect(
    waitForAssertion(() => {
      controller.abort();
      throw new Error("still missing");
    }, controller.signal),
  ).rejects.toThrow("still missing");
});
