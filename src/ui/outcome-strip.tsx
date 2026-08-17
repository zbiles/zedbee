import { Box, Text } from "ink";
import type { ScanReport } from "../scan/report.js";
import { PixelBee } from "./pixel-bee.js";
import { colorProp, ZEDBEE_THEME } from "./theme.js";

function copyFor(
  report: ScanReport,
  narrow: boolean,
): readonly [string, string, string] {
  const { passed, warnings, failed } = report.summary;
  const warningLabel = warnings === 1 ? "warning" : "warnings";
  if (report.outcome === "blocked") {
    return [
      "THAT STINGS",
      narrow ? "Commit blocked." : "A check failed. Commit blocked.",
      `${passed} passed · ${warnings} ${warningLabel} · ${failed} failed`,
    ];
  }
  if (report.outcome === "incomplete") {
    return [
      "SCAN INCOMPLETE",
      narrow
        ? "Commit blocked."
        : "A required check could not finish. Commit blocked.",
      `${passed} passed · ${warnings} ${warningLabel} · ${failed} failed`,
    ];
  }
  if (report.stagedFileCount === 0) {
    return [
      "BEE-UTIFUL",
      "No staged changes. Commit allowed.",
      "0 passed · 0 warnings",
    ];
  }
  return [
    "BEE-UTIFUL",
    narrow ? "Commit allowed." : "All checks passed. Commit allowed.",
    `${passed} passed · ${warnings} ${warningLabel}`,
  ];
}

function outcomeColor(report: ScanReport): string {
  if (report.outcome === "blocked") {
    return ZEDBEE_THEME.failure;
  }
  if (report.outcome === "incomplete") {
    return ZEDBEE_THEME.warning;
  }
  return ZEDBEE_THEME.pass;
}

function TrafficLight({
  report,
  color,
}: {
  report: ScanReport;
  color: boolean;
}) {
  const active =
    report.outcome === "blocked" ? 0 : report.outcome === "incomplete" ? 1 : 2;
  const colors = [
    ZEDBEE_THEME.failure,
    ZEDBEE_THEME.warning,
    ZEDBEE_THEME.pass,
  ];
  return (
    <Box flexDirection="column" marginRight={2}>
      {colors.map((light, index) => (
        <Text
          key={light}
          {...colorProp(color, index === active ? light : ZEDBEE_THEME.muted)}
        >
          ●
        </Text>
      ))}
    </Box>
  );
}

export function OutcomeStrip({
  report,
  width,
  color,
}: {
  report: ScanReport;
  width: number;
  color: boolean;
}) {
  const narrow = width < 96;
  const [headline, subline, counts] = copyFor(report, narrow);
  const showMotion = width >= 80;
  const showBee = width >= 52;
  const beeWidth = showMotion ? 53 : showBee ? 20 : 0;
  const copyWidth = Math.max(1, width - 3 - beeWidth);

  return (
    <Box width={width} flexDirection="row" flexWrap="nowrap">
      <TrafficLight report={report} color={color} />
      <Box flexDirection="column" width={copyWidth}>
        <Text bold {...colorProp(color, outcomeColor(report))}>
          {headline}
        </Text>
        <Text {...colorProp(color, ZEDBEE_THEME.primary)}>{subline}</Text>
        <Text {...colorProp(color, ZEDBEE_THEME.secondary)}>{counts}</Text>
      </Box>
      {showBee ? <PixelBee mirrored motion={showMotion} color={color} /> : null}
    </Box>
  );
}
