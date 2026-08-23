import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import {
  Box,
  measureElement,
  Text,
  render,
  useApp,
  useInput,
  useWindowSize,
  type DOMElement,
} from "ink";
import {
  CHECK_IDS,
  PROFILE_IDS,
  type CheckId,
  type ProfileId,
} from "../config/schema.js";
import type { InitPromptOptions } from "../commands/init.js";
import type {
  InitFileChange,
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
import {
  clampScrollOffset,
  minimalRevealOffset,
  pageScrollStep,
  parseSgrWheelDelta,
} from "./terminal-viewport-model.js";
import {
  TerminalViewport,
  type TerminalViewportMetrics,
} from "./terminal-viewport.js";
import { colorProp, ZEDBEE_THEME } from "./theme.js";

export interface InitAppProps extends InitPromptOptions {
  readonly proposal: InitProposal;
  readonly terminalSize?: Readonly<{ columns: number; rows: number }>;
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
const SGR_MOUSE_REPORT = /(?:\u001b)?\[<\d+;\d+;\d+[Mm]/u;

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
  activeTargetRef,
  color,
}: {
  readonly proposal: InitProposal;
  readonly profile: ProfileId | "custom";
  readonly baseProfile: ProfileId;
  readonly focused: boolean;
  readonly activeTargetRef: RefObject<DOMElement | null>;
  readonly color: boolean;
}) {
  const installsHook = proposal.hook !== "none";
  const explanation =
    profile === "custom"
      ? "Custom checks based on the " + baseProfile + " profile."
      : PROFILE_EXPLANATIONS[profile];
  return (
    <Box flexDirection="column" paddingX={2}>
      <Box ref={focused ? activeTargetRef : undefined}>
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
  activeTargetRef,
  color,
}: {
  readonly cursor: number;
  readonly selected: ReadonlySet<CheckId>;
  readonly activeTargetRef: RefObject<DOMElement | null>;
  readonly color: boolean;
}) {
  return (
    <Box flexDirection="column" paddingX={2}>
      <Text bold {...colorProp(color, ZEDBEE_THEME.primary)}>
        CHECKS
      </Text>
      {CHECK_IDS.map((check, index) => (
        <Box key={check} ref={index === cursor ? activeTargetRef : undefined}>
          <Text
            {...colorProp(
              color,
              index === cursor ? ZEDBEE_THEME.yellow : ZEDBEE_THEME.secondary,
            )}
          >
            {index === cursor ? "➜" : " "} [{selected.has(check) ? "✽" : " "}]{" "}
            {check}
          </Text>
        </Box>
      ))}
    </Box>
  );
}

function VulnerabilityOutageChoice({
  value,
  cursor,
  activeTargetRef,
  color,
}: {
  readonly value: InitOsvUnavailable;
  readonly cursor: number;
  readonly activeTargetRef: RefObject<DOMElement | null>;
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
      <Box ref={cursor === 0 ? activeTargetRef : undefined}>
        <Text
          {...colorProp(
            color,
            cursor === 0 ? ZEDBEE_THEME.yellow : ZEDBEE_THEME.secondary,
          )}
        >
          {cursor === 0 ? "➜" : " "} [{value === "block" ? "✽" : " "}] Block the
          commit (recommended)
        </Text>
      </Box>
      <Box ref={cursor === 1 ? activeTargetRef : undefined}>
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

function setupReviewFocusIndex(vulnerabilityScanningAvailable: boolean) {
  return CHECK_IDS.length + (vulnerabilityScanningAvailable ? 3 : 1);
}

function InitActionButton({
  label,
  focused,
  activeTargetRef,
  color,
}: {
  readonly label: string;
  readonly focused: boolean;
  readonly activeTargetRef?: RefObject<DOMElement | null>;
  readonly color: boolean;
}) {
  return (
    <Box
      ref={focused ? activeTargetRef : undefined}
      justifyContent="center"
      paddingX={2}
    >
      <Box
        borderStyle="single"
        paddingX={2}
        {...(color
          ? {
              borderColor: ZEDBEE_THEME.yellow,
              borderBackgroundColor: focused ? ZEDBEE_THEME.yellow : "#000000",
              backgroundColor: focused ? ZEDBEE_THEME.yellow : "#000000",
            }
          : {})}
      >
        <Text
          bold
          inverse={!color && focused}
          {...(color
            ? {
                color: focused ? ZEDBEE_THEME.beeBlack : ZEDBEE_THEME.wordmark,
                backgroundColor: focused ? ZEDBEE_THEME.yellow : "#000000",
              }
            : {})}
        >
          {label}
        </Text>
      </Box>
    </Box>
  );
}

function initFileDescription(file: InitFileChange): string {
  const action = file.before === null ? "Create" : "Update";
  switch (file.relativePath) {
    case ".zedbeerc.jsonc":
      return `${action} Zedbee's repository configuration with the selected profile, checks, and reporting settings.`;
    case ".git/hooks/pre-commit":
      return `${action} the Git pre-commit hook so Zedbee runs before each commit.`;
    case ".husky/pre-commit":
      return `${action} the Husky pre-commit hook so Zedbee runs before each commit.`;
    case "lefthook.yml":
    case "lefthook.yaml":
      return `${action} the Lefthook configuration so Zedbee runs before each commit.`;
    case "package.json":
      return `${action} package.json so simple-git-hooks runs Zedbee before each commit.`;
    default:
      return `${action} this file as part of Zedbee initialization.`;
  }
}

function SetupPanel({
  proposal,
  focus,
  profile,
  baseProfile,
  selected,
  osvUnavailable,
  width,
  activeTargetRef,
  color,
}: {
  readonly proposal: InitProposal;
  readonly focus: number;
  readonly profile: ProfileId | "custom";
  readonly baseProfile: ProfileId;
  readonly selected: ReadonlySet<CheckId>;
  readonly osvUnavailable: InitOsvUnavailable;
  readonly width: number;
  readonly activeTargetRef: RefObject<DOMElement | null>;
  readonly color: boolean;
}) {
  return (
    <BrandedCommandPanel title="SETUP" width={width} color={color}>
      <SetupSummary
        proposal={proposal}
        profile={profile}
        baseProfile={baseProfile}
        focused={focus === 0}
        activeTargetRef={activeTargetRef}
        color={color}
      />
      <BrandedCommandPanelRule width={width} color={color} />
      <CheckChoices
        cursor={focus - 1}
        selected={selected}
        activeTargetRef={activeTargetRef}
        color={color}
      />
      <NetworkDisclosures proposal={proposal} width={width} color={color} />
      {proposal.vulnerabilityScanningAvailable ? (
        <>
          <BrandedCommandPanelRule width={width} color={color} />
          <VulnerabilityOutageChoice
            value={osvUnavailable}
            cursor={focus - CHECK_IDS.length - 1}
            activeTargetRef={activeTargetRef}
            color={color}
          />
        </>
      ) : null}
      <Text> </Text>
      <InitActionButton
        label="REVIEW CHANGES"
        focused={
          focus ===
          setupReviewFocusIndex(proposal.vulnerabilityScanningAvailable)
        }
        activeTargetRef={activeTargetRef}
        color={color}
      />
      <Text> </Text>
      <Box paddingX={2}>
        <Text wrap="wrap" {...colorProp(color, ZEDBEE_THEME.muted)}>
          ↑↓ Move · ←→ Change profile · Space Select · Enter Review · Esc Cancel
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
      <Box flexDirection="column" paddingX={2}>
        <Text wrap="wrap" {...colorProp(color, ZEDBEE_THEME.secondary)}>
          Review these changes before Zedbee saves them to your repository.
        </Text>
        <Text> </Text>
      </Box>
      <BrandedCommandPanelRule width={width} color={color} />
      {proposal.files.map((file, index) => (
        <Box key={file.relativePath} flexDirection="column">
          <Box flexDirection="column" paddingX={2}>
            <Text bold {...colorProp(color, ZEDBEE_THEME.primary)}>
              {file.relativePath}
            </Text>
            <Text wrap="wrap" {...colorProp(color, ZEDBEE_THEME.secondary)}>
              {initFileDescription(file)}
            </Text>
            <Text> </Text>
          </Box>
          {index < proposal.files.length - 1 ? (
            <BrandedCommandPanelRule width={width} color={color} />
          ) : null}
        </Box>
      ))}
      <InitActionButton label="APPLY CHANGES" focused color={color} />
      <Text> </Text>
      <Box paddingX={2}>
        <Text wrap="wrap" {...colorProp(color, ZEDBEE_THEME.muted)}>
          Space/Enter/Y Apply · Esc/B Back · N Cancel
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
  terminalSize,
  color,
  onDecision,
}: InitAppProps) {
  const { exit } = useApp();
  const liveSize = useWindowSize();
  const columns = terminalSize?.columns ?? liveSize.columns ?? width;
  const rows = terminalSize?.rows ?? liveSize.rows ?? 24;
  const [phase, setPhase] = useState<"configure" | "review">("configure");
  const [focus, setFocus] = useState(0);
  const [setupOffset, setSetupOffset] = useState(0);
  const [reviewOffset, setReviewOffset] = useState(0);
  const [viewportMetrics, setViewportMetrics] =
    useState<TerminalViewportMetrics>({
      contentHeight: 0,
      visibleHeight: rows,
    });
  const [baseProfile, setBaseProfile] = useState<ProfileId>(proposal.profile);
  const [customized, setCustomized] = useState(false);
  const [selected, setSelected] = useState(
    () => new Set<CheckId>(proposal.recommendedChecks),
  );
  const [osvUnavailable, setOsvUnavailable] = useState<InitOsvUnavailable>(
    proposal.osvUnavailable,
  );
  const activeTargetRef = useRef<DOMElement>(null);
  const contentRef = useRef<DOMElement>(null);
  const setupOffsetRef = useRef(setupOffset);
  const lastSetupRevealRef = useRef<
    | Readonly<{
        columns: number;
        rows: number;
        focus: number;
      }>
    | undefined
  >(undefined);
  const pendingSetupGeometryRef = useRef(false);
  setupOffsetRef.current = setupOffset;
  const reviewedProposal = useMemo(
    () =>
      proposalForSelection(
        baseProfile,
        Object.freeze(CHECK_IDS.filter((check) => selected.has(check))),
        osvUnavailable,
      ),
    [baseProfile, osvUnavailable, proposalForSelection, selected],
  );

  useEffect(() => {
    const previous = lastSetupRevealRef.current;
    const geometryChanged =
      previous === undefined ||
      previous.columns !== columns ||
      previous.rows !== rows;
    if (phase !== "configure") {
      pendingSetupGeometryRef.current = geometryChanged;
      return;
    }
    const focusChanged = previous === undefined || previous.focus !== focus;
    const shouldReveal =
      focusChanged || geometryChanged || pendingSetupGeometryRef.current;
    pendingSetupGeometryRef.current = false;
    lastSetupRevealRef.current = { columns, rows, focus };
    if (!shouldReveal) return;
    const target = activeTargetRef.current;
    const content = contentRef.current;
    if (target === null || content === null) return;
    const targetBounds = measureElement(target);
    const contentBounds = measureElement(content);
    if (targetBounds.height <= 0 || contentBounds.height <= 0) return;
    const terminalHeight = Math.max(1, Math.trunc(rows));
    const visibleHeight =
      contentBounds.height > terminalHeight && terminalHeight >= 3
        ? terminalHeight - 2
        : terminalHeight;
    const currentOffset = setupOffsetRef.current;
    const nextOffset = minimalRevealOffset(
      currentOffset,
      visibleHeight,
      targetBounds.y - contentBounds.y,
      targetBounds.height,
      contentBounds.height,
    );
    if (nextOffset !== currentOffset) setSetupOffset(nextOffset);
  }, [columns, focus, phase, rows]);

  const scrollBy = (delta: number) => {
    const setOffset = phase === "configure" ? setSetupOffset : setReviewOffset;
    setOffset((current) =>
      clampScrollOffset(
        current + delta,
        viewportMetrics.contentHeight,
        viewportMetrics.visibleHeight,
      ),
    );
  };

  useInput((input, key) => {
    const normalized = input.toLowerCase();
    const wheelDelta = parseSgrWheelDelta(input);
    if (SGR_MOUSE_REPORT.test(input)) {
      if (wheelDelta !== 0) scrollBy(wheelDelta);
      return;
    }
    if (key.pageUp || key.pageDown) {
      const direction = key.pageDown ? 1 : -1;
      scrollBy(direction * pageScrollStep(viewportMetrics.visibleHeight));
      return;
    }
    if (phase === "review") {
      if (key.upArrow || key.downArrow) {
        scrollBy(key.downArrow ? 1 : -1);
      } else if (normalized === "y" || key.return || input === " ") {
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
        setupReviewFocusIndex(proposal.vulnerabilityScanningAvailable) + 1;
      setFocus((value) => (value - 1 + focusCount) % focusCount);
    } else if (key.downArrow) {
      const focusCount =
        setupReviewFocusIndex(proposal.vulnerabilityScanningAvailable) + 1;
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
      if (
        focus === setupReviewFocusIndex(proposal.vulnerabilityScanningAvailable)
      ) {
        setPhase("review");
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

  const panelWidth = brandedCommandContentWidth(columns);
  const activeOffset = phase === "configure" ? setupOffset : reviewOffset;
  const setActiveOffset =
    phase === "configure" ? setSetupOffset : setReviewOffset;
  return (
    <TerminalViewport
      key={phase}
      width={columns}
      height={rows}
      offset={activeOffset}
      color={color}
      contentRef={contentRef}
      onOffsetChange={setActiveOffset}
      onMetricsChange={setViewportMetrics}
    >
      <BrandedCommandFrame width={columns} color={color}>
        {phase === "configure" ? (
          <SetupPanel
            proposal={reviewedProposal}
            focus={focus}
            profile={customized ? "custom" : baseProfile}
            baseProfile={baseProfile}
            selected={selected}
            osvUnavailable={osvUnavailable}
            width={panelWidth}
            activeTargetRef={activeTargetRef}
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
    </TerminalViewport>
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
