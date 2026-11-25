export function assertUpgradeCommit(
  report: unknown,
  expected: Readonly<{
    workspace: string;
    files: number;
    error?: boolean;
    skipped?: string;
    healthySibling?: string;
  }>,
): void;

export function smokeConsumerUpgrades(options: {
  root: string;
  version: string;
  scratch: string;
  archive?: string;
  cache?: string;
  run: (...args: any[]) => string;
}): readonly string[];
