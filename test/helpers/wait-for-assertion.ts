import { setTimeout } from "node:timers/promises";
import { currentTestSignal } from "./current-test-signal.js";

// Rendering and background work share the run's deadline, not a second short
// polling deadline. A failed condition stays pending until it succeeds or the
// run is canceled. Keep the real assertion; never turn missing output into a pass.
export async function waitForAssertion<T>(
  assertion: () => T | Promise<T>,
  signal = currentTestSignal(),
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
