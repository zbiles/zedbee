export type ScanMode = "index" | "base";

export interface ScanSourceIdentity {
  readonly mode: ScanMode;
  readonly baseline: "HEAD" | string | null;
  readonly target: "index" | string | null;
  readonly requestedBase?: string;
}
