export interface DependencyRecord {
  readonly name: string;
  readonly version: string;
  readonly ecosystem: "npm";
  readonly lockfilePath: string;
  readonly line?: number;
  readonly importer?: string;
  readonly dependencyPath?: readonly string[];
}

export type DependencyInventory = readonly DependencyRecord[];
