export function benchmarkSamples<E, R>(options: {
  mode: "cold" | "warm-engine" | "warm-cache";
  samples: number;
  open(): Promise<E>;
  close(executor: E): Promise<void>;
  run(executor: E, cache: boolean): Promise<R>;
}): Promise<R[]>;
