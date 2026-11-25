export function benchmarkSamples<E, R>(options: {
  mode: "cold" | "warm-engine" | "warm-cache";
  samples: number;
  open(): Promise<E>;
  close(executor: E): Promise<void>;
  run(executor: E, cache: boolean): Promise<R>;
}): Promise<R[]>;

export function median(values: readonly number[]): number;
export function matchesCacheMode(
  mode: string,
  observed: { gets: number; hits: number; sets: number },
): boolean;
