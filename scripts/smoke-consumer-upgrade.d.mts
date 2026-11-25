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
