const exitCodes = Object.freeze({ pass: 0, blocked: 1, incomplete: 2 });
export function validScanVerdict(outcome, reportCode, processCode) {
  return (
    typeof outcome === "string" &&
    Object.hasOwn(exitCodes, outcome) &&
    exitCodes[outcome] === processCode &&
    reportCode === processCode
  );
}
