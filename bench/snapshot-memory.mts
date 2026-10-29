import { execa } from "execa";

/** External RSS sampler: retains discovered descendants across reparenting. */
export function sampleProcessTree() {
  const owned = new Set<number>();
  let stopped = false;
  let peakRssBytes = 0;
  let samples = 0;
  let failure: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let wake: (() => void) | undefined;
  const pending = (async () => {
    while (!stopped) {
      try {
        if (process.platform === "win32")
          throw new Error("Windows process-tree sampler unavailable");
        const result = await execa("ps", ["-axo", "pid=,ppid=,rss="]);
        const rows = result.stdout
          .trim()
          .split("\n")
          .map((line) => line.trim().split(/\s+/u).map(Number));
        for (let changed = true; changed;) {
          changed = false;
          for (const [pid, parent] of rows)
            if (
              pid !== undefined &&
              parent !== undefined &&
              owned.has(parent) &&
              !owned.has(pid)
            ) {
              owned.add(pid);
              changed = true;
            }
        }
        const rss = rows.reduce(
          (sum, [pid, _parent, kib]) =>
            sum + (pid !== undefined && owned.has(pid) ? (kib ?? 0) * 1024 : 0),
          0,
        );
        if (rss > 0) {
          samples++;
          peakRssBytes = Math.max(peakRssBytes, rss);
        }
      } catch (error) {
        failure = error instanceof Error ? error.message : "RSS unavailable";
        break;
      }
      if (!stopped)
        await new Promise<void>((resolve) => {
          wake = resolve;
          timer = setTimeout(resolve, 100);
        });
    }
  })();
  return {
    add: (pid: number) => {
      owned.add(pid);
    },
    async stop() {
      stopped = true;
      clearTimeout(timer);
      wake?.();
      await pending;
      return {
        peakRssBytes,
        samples,
        intervalMs: 100,
        verified: failure === undefined && samples > 0,
        ...(failure === undefined ? {} : { failure }),
      };
    },
  };
}
