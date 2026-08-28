import { Box, Text } from "ink";
import type { FixPlan, FixResult } from "../fixes/types.js";
import {
  brandedCommandContentWidth,
  BrandedCommandFrame,
  BrandedCommandPanel,
  BrandedCommandPanelRule,
} from "./branded-command-frame.js";
import { CheckStatusPanel } from "./fix-app.js";
import { renderStaticInk } from "./render-static.js";
import { colorProp, ZEDBEE_THEME } from "./theme.js";

const NEXT_STEP_PREFIX =
  "Review Zedbee's changes, stage the ones you want to keep, then run ";
const NEXT_STEP_SUFFIX =
  " to verify the updated staged code and identify remaining findings.";

function outcomeFor(plan: FixPlan, result: FixResult) {
  if (plan.exitCode === 0 && result.exitCode === 0) {
    return { label: "APPLIED", tone: ZEDBEE_THEME.pass } as const;
  }
  if (result.appliedFixes > 0) {
    return { label: "PARTIALLY APPLIED", tone: ZEDBEE_THEME.warning } as const;
  }
  return { label: "FAILED", tone: ZEDBEE_THEME.failure } as const;
}

function SummaryRow({
  label,
  value,
  color,
}: {
  readonly label: string;
  readonly value: string | number;
  readonly color: boolean;
}) {
  return (
    <Box paddingX={2}>
      <Text {...colorProp(color, ZEDBEE_THEME.secondary)}>{label}</Text>
      <Box flexGrow={1} minWidth={1} />
      <Text bold {...colorProp(color, ZEDBEE_THEME.primary)}>
        {value}
      </Text>
    </Box>
  );
}

function FixResultPanel({
  plan,
  result,
  width,
  color,
}: {
  readonly plan: FixPlan;
  readonly result: FixResult;
  readonly width: number;
  readonly color: boolean;
}) {
  const outcome = outcomeFor(plan, result);
  return (
    <BrandedCommandPanel title="FIX RESULT" width={width} color={color}>
      <Text> </Text>
      <Box paddingX={2}>
        <Text bold {...colorProp(color, outcome.tone)}>
          {outcome.label}
        </Text>
      </Box>
      <Text> </Text>
      <SummaryRow
        label="Applied fixes"
        value={result.appliedFixes}
        color={color}
      />
      <SummaryRow
        label="Changed files"
        value={result.changedFiles.length}
        color={color}
      />
      <SummaryRow
        label="Unchanged files"
        value={result.unchangedFiles.length}
        color={color}
      />
      <SummaryRow
        label="Plan findings"
        value={`${plan.summary.blocking} blocking · ${plan.summary.warnings} ${
          plan.summary.warnings === 1 ? "warning" : "warnings"
        }`}
        color={color}
      />
      <Text> </Text>
    </BrandedCommandPanel>
  );
}

function ApplicationIssuesPanel({
  result,
  width,
  color,
}: {
  readonly result: FixResult;
  readonly width: number;
  readonly color: boolean;
}) {
  if (result.issues.length === 0) return null;
  return (
    <BrandedCommandPanel title="APPLICATION ISSUES" width={width} color={color}>
      {result.issues.map((issue, index) => (
        <Box key={`${issue.kind}:${issue.file}`} flexDirection="column">
          <Box flexDirection="column" paddingX={2}>
            <Text bold wrap="wrap" {...colorProp(color, ZEDBEE_THEME.failure)}>
              {issue.kind.toUpperCase()} — {issue.file}
            </Text>
            <Text wrap="wrap" {...colorProp(color, ZEDBEE_THEME.secondary)}>
              {issue.message}
            </Text>
            <Text wrap="wrap" {...colorProp(color, ZEDBEE_THEME.warning)}>
              Remediation: {issue.remediation}
            </Text>
          </Box>
          {index < result.issues.length - 1 ? (
            <BrandedCommandPanelRule width={width} color={color} />
          ) : null}
        </Box>
      ))}
      <Text> </Text>
    </BrandedCommandPanel>
  );
}

function NextStepPanel({
  width,
  color,
}: {
  readonly width: number;
  readonly color: boolean;
}) {
  return (
    <BrandedCommandPanel title="NEXT STEP" width={width} color={color}>
      <Text> </Text>
      <Box paddingX={2}>
        <Text wrap="wrap" {...colorProp(color, ZEDBEE_THEME.secondary)}>
          {NEXT_STEP_PREFIX}
          <Text bold {...colorProp(color, ZEDBEE_THEME.yellow)}>
            zedbee scan
          </Text>
          {NEXT_STEP_SUFFIX}
        </Text>
      </Box>
      <Text> </Text>
    </BrandedCommandPanel>
  );
}

export function FixResultDashboard({
  plan,
  result,
  width,
  color,
}: {
  readonly plan: FixPlan;
  readonly result: FixResult;
  readonly width: number;
  readonly color: boolean;
}) {
  const contentWidth = brandedCommandContentWidth(width);
  const hasChecks = (plan.checks?.length ?? 0) > 0;
  const hasIssues = result.issues.length > 0;
  return (
    <BrandedCommandFrame width={width} color={color}>
      <FixResultPanel
        plan={plan}
        result={result}
        width={contentWidth}
        color={color}
      />
      {hasChecks ? (
        <>
          <Text> </Text>
          <CheckStatusPanel plan={plan} width={contentWidth} color={color} />
        </>
      ) : null}
      {hasIssues ? (
        <>
          <Text> </Text>
          <ApplicationIssuesPanel
            result={result}
            width={contentWidth}
            color={color}
          />
        </>
      ) : null}
      <Text> </Text>
      <NextStepPanel width={contentWidth} color={color} />
    </BrandedCommandFrame>
  );
}

export async function runInkFixResult(
  plan: FixPlan,
  result: FixResult,
  options: { readonly width: number; readonly color: boolean },
): Promise<void> {
  await renderStaticInk(
    <FixResultDashboard plan={plan} result={result} {...options} />,
    { width: options.width },
  );
}
