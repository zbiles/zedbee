export interface OsvPackageQuery {
  readonly name: string;
  readonly version: string;
  readonly ecosystem: "npm";
}

export interface OsvRangeEvent {
  readonly introduced?: string;
  readonly fixed?: string;
  readonly lastAffected?: string;
  readonly limit?: string;
}

export interface OsvAffectedPackage {
  readonly package: {
    readonly name: string;
    readonly ecosystem: string;
  };
  readonly ranges: readonly {
    readonly type: string;
    readonly events: readonly OsvRangeEvent[];
  }[];
  readonly versions: readonly string[];
}

export interface OsvAdvisory {
  readonly id: string;
  readonly aliases: readonly string[];
  readonly affected: readonly OsvAffectedPackage[];
  readonly severity: readonly { readonly type: string; readonly score: string }[];
  readonly references: readonly { readonly type: string; readonly url: string }[];
}

export interface OsvClient {
  query(
    packages: readonly OsvPackageQuery[],
    signal: AbortSignal,
  ): Promise<ReadonlyMap<string, readonly OsvAdvisory[]>>;
  probe(signal: AbortSignal): Promise<void>;
}
