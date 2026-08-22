import { useMemo, useState } from "react";
import { Box, Text, render, useApp, useInput } from "ink";
import { CHECK_IDS, type CheckId } from "../config/schema.js";
import type { InitPromptOptions } from "../commands/init.js";
import type {
  InitOsvUnavailable,
  InitProposal,
  ResolvedHookChoice,
} from "../init/types.js";
import {
  brandedCommandContentWidth,
  BrandedCommandFrame,
  BrandedCommandPanel,
  BrandedCommandPanelRule,
} from "./branded-command-frame.js";
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

const HOOK_METHODS: Readonly<Record<ResolvedHookChoice, string>> = {
  none: "None",
  raw: "Git pre-commit hook",
  husky: "Husky",
  lefthook: "Lefthook",
  "simple-git-hooks": "simple-git-hooks",
};

const INIT_EVENT_MAX_FPS = 30;

export function initMaxFps(): number {
  return INIT_EVENT_MAX_FPS;
}

export function initRenderOptions() {
  return Object.freeze({
    exitOnCtrlC: false,
    patchConsole: false,
    maxFps: initMaxFps(),
    alternateScreen: true,
  });
}

function SetupSummary({
  proposal,
  color,
}: {
  readonly proposal: InitProposal;
  readonly color: boolean;
}) {
  const installsHook = proposal.hook !== "none";
  return (
    <Box flexDirection="column" paddingX={2}>
      <Box>
        <Text {...colorProp(color, ZEDBEE_THEME.secondary)}>Profile: </Text>
        <Text bold {...colorProp(color, ZEDBEE_THEME.primary)}>
          {proposal.profile}
        </Text>
      </Box>
      <Text wrap="wrap" {...colorProp(color, ZEDBEE_THEME.secondary)}>
        {PROFILE_EXPLANATIONS[proposal.profile]}
      </Text>
      <Text> </Text>
      <Box>
        <Text {...colorProp(color, ZEDBEE_THEME.secondary)}>
          Install pre-commit hook:{" "}
        </Text>
        <Text
          bold
          {...colorProp(
            color,
            installsHook ? ZEDBEE_THEME.pass : ZEDBEE_THEME.muted,
          )}
        >
          {installsHook ? "Yes" : "No"}
        </Text>
      </Box>
      {installsHook ? (
        <Text wrap="wrap" {...colorProp(color, ZEDBEE_THEME.secondary)}>
          Method: {HOOK_METHODS[proposal.hook]}
        </Text>
      ) : null}
      {proposal.hookActivation.status === "pending" ? (
        <Text wrap="wrap" {...colorProp(color, ZEDBEE_THEME.warning)}>
          Additional activation required: {proposal.hookActivation.message}
        </Text>
      ) : null}
      {proposal.hookActivation.remediation === undefined ? null : (
        <Text wrap="wrap" {...colorProp(color, ZEDBEE_THEME.warning)}>
          Next step: {proposal.hookActivation.remediation}
        </Text>
      )}
      <Text wrap="wrap" {...colorProp(color, ZEDBEE_THEME.secondary)}>
        Detected: {proposal.detectedEnvironments.join(", ") || "none"}
      </Text>
    </Box>
  );
}

function CheckChoices({
  cursor,
  selected,
  color,
}: {
  readonly cursor: number;
  readonly selected: ReadonlySet<CheckId>;
  readonly color: boolean;
}) {
  return (
    <Box flexDirection="column" paddingX={2}>
      <Text bold {...colorProp(color, ZEDBEE_THEME.primary)}>
        CHECKS
      </Text>
      {CHECK_IDS.map((check, index) => (
        <Text
          key={check}
          {...colorProp(
            color,
            index === cursor ? ZEDBEE_THEME.yellow : ZEDBEE_THEME.secondary,
          )}
        >
          {index === cursor ? ">" : " "} [{selected.has(check) ? "x" : " "}]{" "}
          {check}
        </Text>
      ))}
    </Box>
  );
}

function VulnerabilityOutageChoice({
  value,
  proposal,
  color,
}: {
  readonly value: InitOsvUnavailable;
  readonly proposal: InitProposal;
  readonly color: boolean;
}) {
  return (
    <Box flexDirection="column" paddingX={2}>
      <Text bold {...colorProp(color, ZEDBEE_THEME.primary)}>
        VULNERABILITY SERVICE OUTAGES
      </Text>
      <Text wrap="wrap" {...colorProp(color, ZEDBEE_THEME.secondary)}>
        What should Zedbee do if OSV cannot be reached?
      </Text>
      <Text
        {...colorProp(
          color,
          value === "block" ? ZEDBEE_THEME.yellow : ZEDBEE_THEME.secondary,
        )}
      >
        {value === "block" ? "●" : "○"} [B] Block the commit (recommended)
      </Text>
      <Text
        {...colorProp(
          color,
          value === "warn" ? ZEDBEE_THEME.yellow : ZEDBEE_THEME.secondary,
        )}
      >
        {value === "warn" ? "●" : "○"} [W] Warn and allow the commit
      </Text>
      {proposal.networkChecks.map((check) => (
        <Text
          key={check.id}
          wrap="wrap"
          {...colorProp(color, ZEDBEE_THEME.warning)}
        >
          Network disclosure: {check.disclosure}
        </Text>
      ))}
    </Box>
  );
}

function SetupPanel({
  proposal,
  cursor,
  selected,
  osvUnavailable,
  width,
  color,
}: {
  readonly proposal: InitProposal;
  readonly cursor: number;
  readonly selected: ReadonlySet<CheckId>;
  readonly osvUnavailable: InitOsvUnavailable;
  readonly width: number;
  readonly color: boolean;
}) {
  return (
    <BrandedCommandPanel title="SETUP" width={width} color={color}>
      <SetupSummary proposal={proposal} color={color} />
      <BrandedCommandPanelRule width={width} color={color} />
      <CheckChoices cursor={cursor} selected={selected} color={color} />
      {proposal.vulnerabilityScanningAvailable ? (
        <>
          <BrandedCommandPanelRule width={width} color={color} />
          <VulnerabilityOutageChoice
            value={osvUnavailable}
            proposal={proposal}
            color={color}
          />
        </>
      ) : null}
      <Text> </Text>
      <Box paddingX={2}>
        <Text wrap="wrap" {...colorProp(color, ZEDBEE_THEME.muted)}>
          ↑↓ Move · Space Toggle · B/W Outage behavior · Enter Review · Esc
          Cancel
        </Text>
      </Box>
      <Text> </Text>
    </BrandedCommandPanel>
  );
}

function ReviewPanel({
  proposal,
  width,
  color,
}: {
  readonly proposal: InitProposal;
  readonly width: number;
  readonly color: boolean;
}) {
  return (
    <BrandedCommandPanel title="REVIEW CHANGES" width={width} color={color}>
      {proposal.files.map((file, index) => (
        <Box key={file.relativePath} flexDirection="column">
          <Box flexDirection="column" paddingX={2}>
            <Text bold {...colorProp(color, ZEDBEE_THEME.primary)}>
              {file.relativePath}
            </Text>
            <Text wrap="wrap" {...colorProp(color, ZEDBEE_THEME.secondary)}>
              {file.diff}
            </Text>
          </Box>
          {index < proposal.files.length - 1 ? (
            <BrandedCommandPanelRule width={width} color={color} />
          ) : null}
        </Box>
      ))}
      <Text> </Text>
      <Box paddingX={2}>
        <Text wrap="wrap" {...colorProp(color, ZEDBEE_THEME.muted)}>
          Enter/Y Apply · Esc/B Back · N Cancel
        </Text>
      </Box>
      <Text> </Text>
    </BrandedCommandPanel>
  );
}

export function InitApp({
  proposal,
  proposalForChecks,
  width,
  color,
  onDecision,
}: InitAppProps) {
  const { exit } = useApp();
  const [phase, setPhase] = useState<"configure" | "review">("configure");
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
    const normalized = input.toLowerCase();
    if (phase === "review") {
      if (normalized === "y" || key.return) {
        onDecision(reviewedProposal);
        exit();
      } else if (normalized === "n") {
        onDecision(false);
        exit();
      } else if (normalized === "b" || key.escape) {
        setPhase("configure");
      }
      return;
    }

    if (key.return) {
      setPhase("review");
    } else if (normalized === "n" || key.escape) {
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
      (normalized === "b" || normalized === "w")
    ) {
      setOsvUnavailable(normalized === "b" ? "block" : "warn");
    }
  });

  const panelWidth = brandedCommandContentWidth(width);
  return (
    <BrandedCommandFrame width={width} color={color}>
      {phase === "configure" ? (
        <SetupPanel
          proposal={reviewedProposal}
          cursor={cursor}
          selected={selected}
          osvUnavailable={osvUnavailable}
          width={panelWidth}
          color={color}
        />
      ) : (
        <ReviewPanel
          proposal={reviewedProposal}
          width={panelWidth}
          color={color}
        />
      )}
    </BrandedCommandFrame>
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
    initRenderOptions(),
  );
  await app.waitUntilExit();
  return decision;
}
