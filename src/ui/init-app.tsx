import { useMemo, useState } from "react";
import { Box, Text, render, useApp, useInput } from "ink";
import { CHECK_IDS, type CheckId } from "../config/schema.js";
import type { InitPromptOptions } from "../commands/init.js";
import type { InitProposal } from "../init/types.js";
import type { InitOsvUnavailable } from "../init/types.js";
import { colorProp, ZEDBEE_THEME } from "./theme.js";

export interface InitAppProps extends InitPromptOptions {
  readonly proposal: InitProposal;
  readonly proposalForChecks: (
    checks: readonly CheckId[],
    osvUnavailable: InitOsvUnavailable,
  ) => InitProposal;
  onDecision(decision: false | InitProposal): void;
}

const PROFILE_EXPLANATIONS = {
  fast: "Fast local checks for tight feedback loops.",
  recommended: "Balanced local checks including types and secrets.",
  thorough: "Every applicable check, including project and network analysis.",
} as const;

export function InitApp({
  proposal,
  proposalForChecks,
  color,
  onDecision,
}: InitAppProps) {
  const { exit } = useApp();
  const [cursor, setCursor] = useState(0);
  const [selected, setSelected] = useState(
    () => new Set<CheckId>(proposal.recommendedChecks),
  );
  const [osvUnavailable, setOsvUnavailable] = useState<InitOsvUnavailable>(
    proposal.osvUnavailable,
  );
  const reviewedProposal = useMemo(
    () =>
      proposalForChecks(
        Object.freeze(CHECK_IDS.filter((check) => selected.has(check))),
        osvUnavailable,
      ),
    [osvUnavailable, proposalForChecks, selected],
  );
  useInput((input, key) => {
    if (input.toLowerCase() === "y" || key.return) {
      onDecision(reviewedProposal);
      exit();
    } else if (input.toLowerCase() === "n" || key.escape) {
      onDecision(false);
      exit();
    } else if (key.upArrow) {
      setCursor((value) => (value - 1 + CHECK_IDS.length) % CHECK_IDS.length);
    } else if (key.downArrow) {
      setCursor((value) => (value + 1) % CHECK_IDS.length);
    } else if (input === " ") {
      const check = CHECK_IDS[cursor];
      if (check !== undefined) {
        setSelected((current) => {
          const next = new Set(current);
          if (next.has(check)) next.delete(check);
          else next.add(check);
          return next;
        });
      }
    } else if (
      proposal.vulnerabilityScanningAvailable &&
      (input.toLowerCase() === "b" || input.toLowerCase() === "w")
    ) {
      setOsvUnavailable(input.toLowerCase() === "b" ? "block" : "warn");
    }
  });
  return (
    <Box flexDirection="column">
      <Text {...colorProp(color, ZEDBEE_THEME.yellow)}>
        Zedbee setup preview
      </Text>
      <Text>Profile: {proposal.profile}</Text>
      <Text>{PROFILE_EXPLANATIONS[proposal.profile]}</Text>
      <Text>Hook: {proposal.hook}</Text>
      <Text>
        Hook activation: {reviewedProposal.hookActivation.status} —{" "}
        {reviewedProposal.hookActivation.message}
      </Text>
      {reviewedProposal.hookActivation.remediation === undefined ? null : (
        <Text {...colorProp(color, ZEDBEE_THEME.warning)}>
          Activation required: {reviewedProposal.hookActivation.remediation}
        </Text>
      )}
      <Text>
        Detected: {proposal.detectedEnvironments.join(", ") || "none"}
      </Text>
      <Text>Check toggles (Up/Down, Space):</Text>
      {CHECK_IDS.map((check, index) => (
        <Text key={check}>
          {index === cursor ? ">" : " "} [{selected.has(check) ? "x" : " "}]{" "}
          {check}
        </Text>
      ))}
      {proposal.vulnerabilityScanningAvailable ? (
        <Text>OSV unavailable: {osvUnavailable} ([B] block · [W] warn)</Text>
      ) : null}
      {reviewedProposal.networkChecks.map((check) => (
        <Text key={check.id} {...colorProp(color, ZEDBEE_THEME.warning)}>
          Network disclosure: {check.disclosure}
        </Text>
      ))}
      {reviewedProposal.files.map((file) => (
        <Box key={file.relativePath} flexDirection="column" marginTop={1}>
          <Text>{file.diff}</Text>
        </Box>
      ))}
      <Text {...colorProp(color, ZEDBEE_THEME.secondary)}>
        Apply these exact changes? [Y/Enter] yes · [N/Esc] no
      </Text>
    </Box>
  );
}

export async function runInitPrompt(
  proposal: InitProposal,
  options: InitPromptOptions,
  proposalForChecks: (
    checks: readonly CheckId[],
    osvUnavailable: InitOsvUnavailable,
  ) => InitProposal,
): Promise<false | InitProposal> {
  let decision: false | InitProposal = false;
  const app = render(
    <InitApp
      proposal={proposal}
      proposalForChecks={proposalForChecks}
      {...options}
      onDecision={(value) => {
        decision = value;
      }}
    />,
    { exitOnCtrlC: false, patchConsole: false, maxFps: 1 },
  );
  await app.waitUntilExit();
  return decision;
}
