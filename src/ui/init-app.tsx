import { useMemo, useState } from "react";
import { Box, Text, render, useApp, useInput } from "ink";
import {
  CHECK_IDS,
  PROFILE_IDS,
  type CheckId,
  type ProfileId,
} from "../config/schema.js";
import type { InitPromptOptions } from "../commands/init.js";
import type {
  InitOsvUnavailable,
  InitProposal,
  ResolvedHookChoice,
} from "../init/types.js";
import { OSV_NETWORK_DISCLOSURE } from "../init/types.js";
import {
  brandedCommandContentWidth,
  BrandedCommandFrame,
  BrandedCommandPanel,
  BrandedCommandPanelRule,
} from "./branded-command-frame.js";
import { colorProp, ZEDBEE_THEME } from "./theme.js";

export interface InitAppProps extends InitPromptOptions {
  readonly proposal: InitProposal;
  readonly proposalForSelection: (
    profile: ProfileId,
    checks: readonly CheckId[] | undefined,
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
const CURSOR_HOME = "\u001b[H";

export function initMaxFps(): number {
  return INIT_EVENT_MAX_FPS;
}

export function initRenderOptions() {
  let homeTemporaryScreen = true;
  return Object.freeze({
    exitOnCtrlC: false,
    patchConsole: false,
    maxFps: initMaxFps(),
    alternateScreen: true,
    onRender() {
      if (!homeTemporaryScreen) return;
      homeTemporaryScreen = false;
      process.stdout.write(CURSOR_HOME);
    },
  });
}

function SetupSummary({
  proposal,
  profile,
  baseProfile,
  focused,
  color,
}: {
  readonly proposal: InitProposal;
  readonly profile: ProfileId | "custom";
  readonly baseProfile: ProfileId;
  readonly focused: boolean;
  readonly color: boolean;
}) {
  const installsHook = proposal.hook !== "none";
  const explanation =
    profile === "custom"
      ? "Custom checks based on the " + baseProfile + " profile."
      : PROFILE_EXPLANATIONS[profile];
  return (
    <Box flexDirection="column" paddingX={2}>
      <Box>
        <Text {...colorProp(color, ZEDBEE_THEME.yellow)}>
          {focused ? "➜" : " "}{" "}
        </Text>
        <Text {...colorProp(color, ZEDBEE_THEME.secondary)}>Profile: </Text>
        {PROFILE_IDS.map((option, index) => (
          <Text
            key={option}
            bold={profile === option}
            {...colorProp(
              color,
              profile === option
                ? ZEDBEE_THEME.primary
                : ZEDBEE_THEME.secondary,
            )}
          >
            {index === 0 ? " " : "  "}
            {option}
          </Text>
        ))}
        {profile === "custom" ? (
          <Text bold {...colorProp(color, ZEDBEE_THEME.primary)}>
            {"  "}custom
          </Text>
        ) : null}
      </Box>
      <Box paddingLeft={2}>
        <Text wrap="wrap" {...colorProp(color, ZEDBEE_THEME.secondary)}>
          {explanation}
        </Text>
      </Box>
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
          {index === cursor ? "➜" : " "} [{selected.has(check) ? "✽" : " "}]{" "}
          {check}
        </Text>
      ))}
    </Box>
  );
}

function VulnerabilityOutageChoice({
  value,
  cursor,
  color,
}: {
  readonly value: InitOsvUnavailable;
  readonly cursor: number;
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
          cursor === 0 ? ZEDBEE_THEME.yellow : ZEDBEE_THEME.secondary,
        )}
      >
        {cursor === 0 ? "➜" : " "} [{value === "block" ? "✽" : " "}] Block the
        commit (recommended)
      </Text>
      <Text
        {...colorProp(
          color,
          cursor === 1 ? ZEDBEE_THEME.yellow : ZEDBEE_THEME.secondary,
        )}
      >
        {cursor === 1 ? "➜" : " "} [{value === "warn" ? "✽" : " "}] Warn and
        allow the commit
      </Text>
    </Box>
  );
}

function NetworkDisclosures({
  proposal,
  width,
  color,
}: {
  readonly proposal: InitProposal;
  readonly width: number;
  readonly color: boolean;
}) {
  const disclosure =
    proposal.networkChecks[0]?.disclosure ?? OSV_NETWORK_DISCLOSURE;
  const lineWidth = Math.max(1, width - 6);
  const disclosureHeight = wordWrappedLineCount(
    "NETWORK DISCLOSURE: " + disclosure,
    lineWidth,
  );
  return (
    <Box flexDirection="column" paddingX={2} height={disclosureHeight + 1}>
      <Text> </Text>
      {proposal.networkChecks.map((check) => (
        <Text key={check.id} wrap="wrap">
          <Text bold {...colorProp(color, ZEDBEE_THEME.warning)}>
            NETWORK DISCLOSURE:{" "}
          </Text>
          <Text {...colorProp(color, ZEDBEE_THEME.secondary)}>
            {check.disclosure}
          </Text>
        </Text>
      ))}
    </Box>
  );
}

function wordWrappedLineCount(value: string, width: number): number {
  let lines = 1;
  let lineLength = 0;
  for (const word of value.split(" ")) {
    if (lineLength === 0) {
      lineLength = word.length;
    } else if (lineLength + word.length + 1 <= width) {
      lineLength += word.length + 1;
    } else {
      lines += 1;
      lineLength = word.length;
    }
  }
  return lines;
}

function SetupPanel({
  proposal,
  focus,
  profile,
  baseProfile,
  selected,
  osvUnavailable,
  width,
  color,
}: {
  readonly proposal: InitProposal;
  readonly focus: number;
  readonly profile: ProfileId | "custom";
  readonly baseProfile: ProfileId;
  readonly selected: ReadonlySet<CheckId>;
  readonly osvUnavailable: InitOsvUnavailable;
  readonly width: number;
  readonly color: boolean;
}) {
  return (
    <BrandedCommandPanel title="SETUP" width={width} color={color}>
      <SetupSummary
        proposal={proposal}
        profile={profile}
        baseProfile={baseProfile}
        focused={focus === 0}
        color={color}
      />
      <BrandedCommandPanelRule width={width} color={color} />
      <CheckChoices cursor={focus - 1} selected={selected} color={color} />
      <NetworkDisclosures proposal={proposal} width={width} color={color} />
      {proposal.vulnerabilityScanningAvailable ? (
        <>
          <BrandedCommandPanelRule width={width} color={color} />
          <VulnerabilityOutageChoice
            value={osvUnavailable}
            cursor={focus - CHECK_IDS.length - 1}
            color={color}
          />
        </>
      ) : null}
      <Text> </Text>
      <Box paddingX={2}>
        <Text wrap="wrap" {...colorProp(color, ZEDBEE_THEME.muted)}>
          ↑↓ Move · ←→ Change profile · Space Toggle · Enter Review · Esc Cancel
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
  proposalForSelection,
  width,
  color,
  onDecision,
}: InitAppProps) {
  const { exit } = useApp();
  const [phase, setPhase] = useState<"configure" | "review">("configure");
  const [focus, setFocus] = useState(0);
  const [baseProfile, setBaseProfile] = useState<ProfileId>(proposal.profile);
  const [customized, setCustomized] = useState(false);
  const [selected, setSelected] = useState(
    () => new Set<CheckId>(proposal.recommendedChecks),
  );
  const [osvUnavailable, setOsvUnavailable] = useState<InitOsvUnavailable>(
    proposal.osvUnavailable,
  );
  const reviewedProposal = useMemo(
    () =>
      proposalForSelection(
        baseProfile,
        Object.freeze(CHECK_IDS.filter((check) => selected.has(check))),
        osvUnavailable,
      ),
    [baseProfile, osvUnavailable, proposalForSelection, selected],
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
      const focusCount =
        CHECK_IDS.length + (proposal.vulnerabilityScanningAvailable ? 3 : 1);
      setFocus((value) => (value - 1 + focusCount) % focusCount);
    } else if (key.downArrow) {
      const focusCount =
        CHECK_IDS.length + (proposal.vulnerabilityScanningAvailable ? 3 : 1);
      setFocus((value) => (value + 1) % focusCount);
    } else if (focus === 0 && (key.leftArrow || key.rightArrow)) {
      const currentIndex = PROFILE_IDS.indexOf(baseProfile);
      const offset = key.rightArrow ? 1 : -1;
      const nextProfile =
        PROFILE_IDS[
          (currentIndex + offset + PROFILE_IDS.length) % PROFILE_IDS.length
        ]!;
      const nextProposal = proposalForSelection(
        nextProfile,
        undefined,
        osvUnavailable,
      );
      setBaseProfile(nextProfile);
      setCustomized(false);
      setSelected(new Set(nextProposal.recommendedChecks));
    } else if (input === " ") {
      if (
        proposal.vulnerabilityScanningAvailable &&
        focus === CHECK_IDS.length + 1
      ) {
        setOsvUnavailable("block");
        return;
      }
      if (
        proposal.vulnerabilityScanningAvailable &&
        focus === CHECK_IDS.length + 2
      ) {
        setOsvUnavailable("warn");
        return;
      }
      const check = CHECK_IDS[focus - 1];
      if (check !== undefined) {
        setSelected((current) => {
          const next = new Set(current);
          if (next.has(check)) next.delete(check);
          else next.add(check);
          return next;
        });
        setCustomized(true);
      }
    }
  });

  const panelWidth = brandedCommandContentWidth(width);
  return (
    <BrandedCommandFrame width={width} color={color}>
      {phase === "configure" ? (
        <SetupPanel
          proposal={reviewedProposal}
          focus={focus}
          profile={customized ? "custom" : baseProfile}
          baseProfile={baseProfile}
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
  proposalForSelection: (
    profile: ProfileId,
    checks: readonly CheckId[] | undefined,
    osvUnavailable: InitOsvUnavailable,
  ) => InitProposal,
): Promise<false | InitProposal> {
  let decision: false | InitProposal = false;
  const app = render(
    <InitApp
      proposal={proposal}
      proposalForSelection={proposalForSelection}
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
