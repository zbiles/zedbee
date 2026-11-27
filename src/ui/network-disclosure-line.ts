import type { ScanReport } from "../scan/report.js";

export function networkDisclosureLine(
  disclosure: ScanReport["networkDisclosures"][number],
): string {
  return `↗ ${disclosure.checkId} sent ${disclosure.metadata.join(", ")} to ${disclosure.services.join(", ")}.`;
}
