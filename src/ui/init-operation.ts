export type InitOperationState =
  | Readonly<{ status: "idle" }>
  | Readonly<{ status: "evaluating" }>
  | Readonly<{ status: "error"; message: string }>;

/** Owns an async setup action independently of React render/input timing. */
export class InitOperation<T> {
  private active:
    { controller: AbortController; cancelled: boolean } | undefined;
  private disposed = false;

  constructor(private readonly publish: (state: InitOperationState) => void) {}

  start(
    operation: (signal: AbortSignal) => Promise<T>,
    accept: (value: T) => void,
  ): void {
    // React state can lag several input events; ownership changes synchronously.
    if (this.disposed || this.active !== undefined) return;
    const active = { controller: new AbortController(), cancelled: false };
    this.active = active;
    this.publish({ status: "evaluating" });
    void (async () => {
      try {
        const value = await operation(active.controller.signal);
        if (!this.disposed && !active.cancelled) accept(value);
      } catch (cause: unknown) {
        if (!this.disposed && !active.cancelled) {
          this.publish({
            status: "error",
            message:
              cause instanceof Error
                ? cause.message
                : "Could not evaluate executable settings.",
          });
          return;
        }
      } finally {
        this.active = undefined;
      }
      if (!this.disposed && !active.cancelled) this.publish({ status: "idle" });
    })();
  }

  cancel(): void {
    if (this.active === undefined) return;
    this.active.cancelled = true;
    this.active.controller.abort();
    // Retain ownership until cleanup settles, even if a provider ignores abort.
    if (!this.disposed) this.publish({ status: "idle" });
  }

  dispose(): void {
    this.disposed = true;
    this.cancel();
  }
}
