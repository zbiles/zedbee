import { Box, Text } from "ink";
import type { FixPlan, FixResult } from "../fixes/types.js";
import {
  presentFixResult,
  type FixResultPresentation,
} from "../fixes/result-presentation.js";
import {
  brandedCommandContentWidth,
  BrandedCommandFrame,
  BrandedCommandPanel,
  BrandedCommandPanelRule,
} from "./branded-command-frame.js";
import { renderStaticInk } from "./render-static.js";
import { colorProp, ZEDBEE_THEME } from "./theme.js";

const NEXT_STEP_PREFIX =
  "Review Zedbee's changes, stage the ones you want to keep, then run ";
const NEXT_STEP_SUFFIX =
  " to verify the updated staged code and identify remaining findings.";

function outcomeFor(outcome: FixResultPresentation["outcome"]) {
  if (outcome === "applied")
    return { label: "APPLIED", tone: ZEDBEE_THEME.pass } as const;
  if (outcome === "partially-applied")
    return { label: "PARTIALLY APPLIED", tone: ZEDBEE_THEME.warning } as const;
  if (outcome === "already-present")
    return {
      label: "FIXES ALREADY PRESENT",
      tone: ZEDBEE_THEME.warning,
    } as const;
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
  const presentation = presentFixResult(plan, result);
  const outcome = outcomeFor(presentation.outcome);
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
        label="Already fixed files"
        value={presentation.alreadyFixedFiles.length}
        color={color}
      />
      <SummaryRow
        label="Unresolved files"
        value={presentation.unresolvedFiles.length}
        color={color}
      />
      <Text> </Text>
      {presentation.alreadyFixedFiles.length > 0 ? (
        <Box flexDirection="column" paddingX={2}>
          <Text wrap="wrap" {...colorProp(color, ZEDBEE_THEME.secondary)}>
            {presentation.alreadyFixedFiles.length}{" "}
            {presentation.alreadyFixedFiles.length === 1
              ? "file already contains"
              : "files already contain"}{" "}
            their planned fixes in the working tree.
          </Text>
          <Text wrap="wrap" {...colorProp(color, ZEDBEE_THEME.warning)}>
            Stage the files you want to keep before running{" "}
            <Text bold {...colorProp(color, ZEDBEE_THEME.wordmark)}>
              zedbee scan
            </Text>
            .
          </Text>
        </Box>
      ) : null}
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
        <Box
          key={`${issue.kind}:${issue.file}:${issue.checkIds.join(",")}:${index}`}
          flexDirection="column"
        >
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
  const hasIssues = result.issues.length > 0;
  return (
    <BrandedCommandFrame width={width} color={color}>
      <FixResultPanel
        plan={plan}
        result={result}
        width={contentWidth}
        color={color}
      />
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
