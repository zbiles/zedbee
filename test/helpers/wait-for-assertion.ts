import { setTimeout } from "node:timers/promises";
import { getCurrentTest } from "@vitest/runner";

// Rendering and background work share the run's deadline, not a second short
// polling deadline. A failed condition stays pending until it succeeds or the
// run is canceled. Keep the real assertion; never turn missing output into a pass.
export async function waitForAssertion<T>(
  assertion: () => T | Promise<T>,
  signal = getCurrentTest()?.context.signal,
): Promise<T> {
  for (;;) {
    signal?.throwIfAborted();
    try {
      return await assertion();
    } catch (error) {
      if (signal?.aborted) throw error;
      await setTimeout(25, undefined, { signal });
    }
  }
}
