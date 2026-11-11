import {
  PROJECT_ESLINT_DISCLOSURE,
  PROJECT_ESLINT_EXECUTION_DISCLOSURE,
  PROJECT_ESLINT_MESSAGES_DISCLOSURE,
} from "../init/eslint-setup.js";
import type { RefObject } from "react";
import { Box, Text, type DOMElement } from "ink";
import {
  CHECK_IDS,
  PROFILE_IDS,
  type CheckId,
  type ProfileId,
} from "../config/schema.js";
import type {
  InitFileChange,
  InitFormattingChoice,
  InitFormattingDetection,
  InitHookChoice,
  InitOsvUnavailable,
  InitProposal,
  ResolvedHookChoice,
} from "../init/types.js";
import { OSV_NETWORK_DISCLOSURE } from "../init/types.js";
import {
  BrandedCommandPanel,
  BrandedCommandPanelRule,
} from "./branded-command-frame.js";
import { colorProp, ZEDBEE_THEME } from "./theme.js";

const PROFILE_EXPLANATIONS = {
  fast: "Fast local checks for tight feedback loops.",
  recommended: "Balanced local checks including types and secrets.",
  thorough: "Every applicable check, including project and network analysis.",
} as const;

const HOOK_METHODS: Readonly<Record<ResolvedHookChoice, string>> = {
  none: "None",
  raw: "Git hooks",
  custom: "Existing tracked hook",
  husky: "Husky",
  lefthook: "Lefthook",
  "simple-git-hooks": "simple-git-hooks",
};

export const FORMATTING_CHOICES: readonly InitFormattingChoice[] = [
  "copy",
  "project",
  "managed",
  "off",
];

// Without a detected project setup, only the secondary choices are offered.
export const SECONDARY_FORMATTING_CHOICES: readonly InitFormattingChoice[] = [
  "managed",
  "off",
];

const FORMATTING_LABELS: Readonly<Record<InitFormattingChoice, string>> = {
  copy: "Copy my settings — one-time import into Zedbee's Prettier.",
  project:
    "Use my project's Prettier — its version, configuration, and plugins.",
  managed: "Use Zedbee defaults — keep the bundled Prettier and settings.",
  off: "Do not check formatting — other Zedbee checks still run.",
};

export const PROJECT_PRETTIER_DISCLOSURE =
  "The project formatter, its configuration, and its plugins are executable code. Trusting them covers every detected Prettier project's formatter across this repository's branches and worktrees, including its future versions and edits.";

function SetupSummary({
  proposal,
  profile,
  baseProfile,
  focused,
  hookFocus,
  activeTargetRef,
  color,
}: {
  readonly proposal: InitProposal;
  readonly profile: ProfileId | "custom";
  readonly baseProfile: ProfileId;
  readonly focused: boolean;
  readonly hookFocus: number;
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
      <Box ref={hookFocus === 1 ? activeTargetRef : undefined}>
        {proposal.hookChoices === undefined ? null : (
          <Text>{hookFocus === 1 ? "➜ " : "  "}</Text>
        )}
        <Text {...colorProp(color, ZEDBEE_THEME.secondary)}>
          Install pre-commit and pre-merge-commit hooks:{" "}
        </Text>
        <Text
          bold
          {...colorProp(
            color,
            installsHook ? ZEDBEE_THEME.pass : ZEDBEE_THEME.muted,
          )}
        >
          {proposal.hookChoices === undefined
            ? installsHook
              ? "Yes"
              : "No"
            : `${installsHook ? "[✽]" : "[ ]"} Yes  ${installsHook ? "[ ]" : "[✽]"} No`}
        </Text>
      </Box>
      {installsHook &&
      proposal.hookChoices?.includes("tracked") &&
      proposal.hookChoices.includes("raw") ? (
        <Box
          flexDirection="column"
          ref={hookFocus === 2 ? activeTargetRef : undefined}
        >
          <Text>
            {hookFocus === 2 ? "➜ " : "  "}[
            {proposal.hookSelection === "tracked" ? "✽" : " "}] Tracked — shared
            with teammates
          </Text>
          <Text>
            {"  "}[{proposal.hookSelection === "raw" ? "✽" : " "}] Local — this
            checkout only
          </Text>
        </Box>
      ) : installsHook && proposal.hookChoices !== undefined ? (
        <Text wrap="wrap" {...colorProp(color, ZEDBEE_THEME.secondary)}>
          {proposal.hookSelection === "tracked"
            ? "Tracked — shared with teammates"
            : proposal.hook === "raw"
              ? "Local — this checkout only"
              : "Reuse the existing tracked integration."}
        </Text>
      ) : installsHook ? (
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
        <Box paddingLeft={2} marginY={1}>
          <Text wrap="wrap" {...colorProp(color, ZEDBEE_THEME.warning)}>
            Next step: {proposal.hookActivation.remediation}
          </Text>
        </Box>
      )}
      {proposal.limitations
        .filter((message) => message.startsWith("Tracked setup is unavailable"))
        .map((message) => (
          <Text
            key={message}
            wrap="wrap"
            {...colorProp(color, ZEDBEE_THEME.warning)}
          >
            {message}
          </Text>
        ))}
      <Box paddingLeft={2}>
        <Text wrap="wrap" {...colorProp(color, ZEDBEE_THEME.secondary)}>
          Detected: {proposal.detectedEnvironments.join(", ") || "none"}
        </Text>
      </Box>
    </Box>
  );
}

function CheckChoices({
  cursor,
  selected,
  projectEslint = false,
  activeTargetRef,
  color,
}: {
  readonly cursor: number;
  readonly selected: ReadonlySet<CheckId>;
  readonly projectEslint?: boolean;
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
            {check === "reactAccessibility"
              ? "Static JSX accessibility checks"
              : check}
            {projectEslint &&
            ["reactCorrectness", "reactAccessibility"].includes(check)
              ? " (controlled by project ESLint)"
              : ""}
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

export function hookFocusCount(proposal: InitProposal): number {
  if (proposal.hookChoices === undefined) return 0;
  return proposal.hook !== "none" &&
    proposal.hookChoices.includes("tracked") &&
    proposal.hookChoices.includes("raw")
    ? 2
    : 1;
}

export function formattingFocusIndex(proposal: InitProposal): number {
  return (
    setupReviewFocusIndex(proposal.vulnerabilityScanningAvailable) +
    hookFocusCount(proposal)
  );
}

export function hasFormattingScope(proposal: InitProposal): boolean {
  return (
    proposal.formattingScope !== undefined &&
    (proposal.formattingScopeRoots?.length ?? 0) > 0 &&
    !proposal.formattingScopeRoots?.includes(".")
  );
}

export function workflowFocusIndex(proposal: InitProposal): number {
  return (
    formattingFocusIndex(proposal) + 1 + (hasFormattingScope(proposal) ? 1 : 0)
  );
}

export function telemetryFocusIndex(proposal: InitProposal): number {
  return (
    workflowFocusIndex(proposal) + (proposal.workflowAvailable === true ? 1 : 0)
  );
}

export function reviewFocusIndex(proposal: InitProposal): number {
  return telemetryFocusIndex(proposal) + 1;
}

function formattingDetectionLines(
  detection:
    | readonly {
        readonly projectRoot: string;
        readonly version?: string;
        readonly status: string;
        readonly executableConfig: boolean;
      }[]
    | undefined,
): readonly string[] {
  if (detection === undefined || detection.length === 0) {
    return [
      "No project Prettier setup detected; Zedbee keeps its managed formatter.",
    ];
  }
  return detection.map((entry) => {
    const location =
      entry.projectRoot === "." ? "repository root" : entry.projectRoot;
    const description =
      entry.status === "missing"
        ? `Prettier setup detected in ${location}, but no installation was found`
        : `Detected Prettier${entry.version === undefined ? "" : ` ${entry.version}`} in ${location} (${entry.status})`;
    return `${description}.${entry.executableConfig ? " Executable configuration detected." : ""}`;
  });
}

function FormattingChoice({
  value,
  focused,
  detection,
  limitations,
  trustConfirmed,
  canEvaluate,
  evaluated,
  activeTargetRef,
  color,
}: {
  readonly value: InitFormattingChoice;
  readonly focused: boolean;
  readonly detection:
    | readonly {
        readonly projectRoot: string;
        readonly version?: string;
        readonly status: string;
        readonly executableConfig: boolean;
      }[]
    | undefined;
  readonly limitations: readonly string[];
  readonly trustConfirmed: boolean;
  readonly canEvaluate: boolean;
  readonly evaluated: boolean;
  readonly activeTargetRef?: RefObject<DOMElement | null>;
  readonly color: boolean;
}) {
  const choices =
    (detection?.length ?? 0) > 0
      ? FORMATTING_CHOICES
      : SECONDARY_FORMATTING_CHOICES;
  return (
    <Box ref={focused ? activeTargetRef : undefined} flexDirection="column">
      <Box paddingRight={2}>
        <Box width={2}>
          <Text {...colorProp(color, ZEDBEE_THEME.yellow)}>
            {focused ? "➜ " : "  "}
          </Text>
        </Box>
        <Text bold {...colorProp(color, ZEDBEE_THEME.primary)}>
          Formatting
        </Text>
      </Box>
      <Box paddingX={4} flexDirection="column">
        {formattingDetectionLines(detection).map((line) => (
          <Text
            key={line}
            wrap="wrap"
            {...colorProp(color, ZEDBEE_THEME.secondary)}
          >
            {line}
          </Text>
        ))}
      </Box>
      {choices.map((choice) => (
        <Box key={choice} paddingX={4}>
          <Text
            wrap="wrap"
            {...colorProp(color, ZEDBEE_THEME.secondary)}
            bold={choice === value}
          >
            [{choice === value ? "✽" : " "}] {FORMATTING_LABELS[choice]}
          </Text>
        </Box>
      ))}
      {value === "project" ? (
        <>
          <Box paddingX={4}>
            <Text wrap="wrap" {...colorProp(color, ZEDBEE_THEME.warning)}>
              {PROJECT_PRETTIER_DISCLOSURE}
            </Text>
          </Box>
          <Box paddingX={4}>
            <Text
              wrap="wrap"
              {...colorProp(color, ZEDBEE_THEME.secondary)}
              bold={trustConfirmed}
            >
              {trustConfirmed
                ? "[✓] Executable-code trust confirmed — press T to withdraw it."
                : "[ ] Press T to confirm executable-code trust before review."}
            </Text>
          </Box>
        </>
      ) : null}
      {value === "copy" && limitations.length > 0 ? (
        <Box paddingX={4} flexDirection="column">
          {limitations.map((limitation) => (
            <Text
              key={limitation}
              wrap="wrap"
              {...colorProp(color, ZEDBEE_THEME.warning)}
            >
              Copy limitation: {limitation}
            </Text>
          ))}
        </Box>
      ) : null}
      {value === "copy" && canEvaluate ? (
        evaluated ? (
          <Box paddingX={4}>
            <Text wrap="wrap" {...colorProp(color, ZEDBEE_THEME.secondary)}>
              Detected executable configurations evaluated once through their
              owning project Prettier installations; unsupported values stay
              listed as limitations.
            </Text>
          </Box>
        ) : (
          <>
            <Box paddingX={4}>
              <Text wrap="wrap" {...colorProp(color, ZEDBEE_THEME.warning)}>
                {PROJECT_PRETTIER_DISCLOSURE}
              </Text>
            </Box>
            <Box paddingX={4}>
              <Text wrap="wrap" {...colorProp(color, ZEDBEE_THEME.secondary)}>
                {trustConfirmed
                  ? "Press E to evaluate all detected executable configurations once through their owning project Prettier installations."
                  : "Press T to confirm executable-code trust, then E to evaluate all detected executable configurations once."}
              </Text>
            </Box>
          </>
        )
      ) : null}
    </Box>
  );
}

export function InitActionButton({
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
  if (file.relativePath.startsWith(".husky/_/"))
    return `${action} the local, ignored dispatcher used to activate Git hooks.`;
  switch (file.relativePath) {
    case ".zedbeerc.jsonc":
      return `${action} Zedbee's repository configuration with the selected profile, checks, and reporting settings.`;
    case ".github/workflows/zedbee.yml":
      return `${action} the GitHub pull-request workflow to run Zedbee scans and upload their reports.`;
    case ".git/hooks/pre-commit":
      return `${action} the Git pre-commit hook so Zedbee runs before each commit.`;
    case ".git/hooks/pre-merge-commit":
      return `${action} the Git pre-merge-commit hook so Zedbee checks changes from every parent before an automatic merge commit.`;
    case ".husky/pre-merge-commit":
      return `${action} the tracked pre-merge-commit hook so Zedbee checks changes from every parent before an automatic merge commit.`;
    case ".husky/pre-commit":
      return `${action} the tracked pre-commit hook so Zedbee runs before each commit.`;
    case "lefthook.yml":
    case "lefthook.yaml":
      return `${action} the Lefthook configuration so Zedbee runs before commits and automatic merge commits.`;
    case "package.json":
      return `${action} package.json to configure hook setup while preserving existing scripts.`;
    case ".husky/install.mjs":
      return `${action} the tracked installer used by prepare; it skips CI and installs without Zedbee.`;
    default:
      return `${action} this file as part of Zedbee initialization.`;
  }
}

export function SetupPanel({
  proposal,
  focus,
  profile,
  baseProfile,
  selected,
  osvUnavailable,
  formatting,
  detection,
  limitations,
  trustConfirmed,
  canEvaluateExecutable,
  evaluatedExecutable,
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
  readonly formatting: InitFormattingChoice;
  readonly detection: InitProposal["formattingDetection"];
  readonly limitations: readonly string[];
  readonly trustConfirmed: boolean;
  readonly canEvaluateExecutable: boolean;
  readonly evaluatedExecutable: boolean;
  readonly width: number;
  readonly activeTargetRef: RefObject<DOMElement | null>;
  readonly color: boolean;
}) {
  const hookRows = hookFocusCount(proposal);
  return (
    <BrandedCommandPanel title="SETUP" width={width} color={color}>
      <SetupSummary
        proposal={proposal}
        profile={profile}
        baseProfile={baseProfile}
        focused={focus === 0}
        hookFocus={focus}
        activeTargetRef={activeTargetRef}
        color={color}
      />
      <BrandedCommandPanelRule width={width} color={color} />
      <CheckChoices
        cursor={focus - 1 - hookRows}
        selected={selected}
        projectEslint={proposal.eslintEngine === "project"}
        activeTargetRef={activeTargetRef}
        color={color}
      />
      <BrandedCommandPanelRule width={width} color={color} />
      <Box flexDirection="column" paddingX={2}>
        <Text bold>ESLint · L changes engine</Text>
        <Text>
          [{proposal.eslintEngine !== "project" ? "✽" : " "}] Use Zedbee's
          built-in ESLint — default
        </Text>
        <Text>
          [{proposal.eslintEngine === "project" ? "✽" : " "}] Use my project's
          ESLint — experimental
        </Text>
        {proposal.eslintEngine === "project" ? (
          <>
            <Text wrap="wrap">{PROJECT_ESLINT_DISCLOSURE}</Text>
            <Text wrap="wrap">{PROJECT_ESLINT_EXECUTION_DISCLOSURE}</Text>
            <Text>
              [{proposal.projectEslintTrustConfirmed ? "✽" : " "}] Trust project
              ESLint execution · X toggles
            </Text>
            <Text wrap="wrap">{PROJECT_ESLINT_MESSAGES_DISCLOSURE}</Text>
            <Text>
              [{proposal.projectEslintMessages === "full" ? "✽" : " "}] Allow
              full local diagnostic messages · M toggles
            </Text>
            <Text>
              {proposal.projectEslintMessages === "full"
                ? "Full messages selected."
                : "Messages stay redacted."}
            </Text>
            {(proposal.eslintConflicts ?? []).map((message) => (
              <Text key={message} wrap="wrap">
                Configuration conflict: {message}
              </Text>
            ))}
            {(proposal.eslintConflicts?.length ?? 0) > 0 ? (
              <Text>
                Resolve these conflicts before applying setup; existing settings
                are preserved.
              </Text>
            ) : null}
          </>
        ) : (
          <Text>Bundled rules and current scan optimizations.</Text>
        )}
      </Box>
      <NetworkDisclosures proposal={proposal} width={width} color={color} />
      {proposal.vulnerabilityScanningAvailable ? (
        <>
          <BrandedCommandPanelRule width={width} color={color} />
          <VulnerabilityOutageChoice
            value={osvUnavailable}
            cursor={focus - CHECK_IDS.length - 1 - hookRows}
            activeTargetRef={activeTargetRef}
            color={color}
          />
        </>
      ) : null}
      <BrandedCommandPanelRule width={width} color={color} />
      <FormattingChoice
        value={formatting}
        focused={focus === formattingFocusIndex(proposal)}
        detection={detection}
        limitations={limitations}
        trustConfirmed={trustConfirmed}
        canEvaluate={canEvaluateExecutable}
        evaluated={evaluatedExecutable}
        activeTargetRef={activeTargetRef}
        color={color}
      />
      {hasFormattingScope(proposal) ? (
        <Box
          flexDirection="column"
          paddingX={2}
          marginTop={1}
          ref={
            focus === formattingFocusIndex(proposal) + 1
              ? activeTargetRef
              : undefined
          }
        >
          <Text {...colorProp(color, ZEDBEE_THEME.secondary)}>
            {focus === formattingFocusIndex(proposal) + 1 ? "➜ " : "  "}
            Formatting scope
          </Text>
          <Box paddingLeft={2} flexDirection="column">
            <Text>
              [{proposal.formattingScope === "projects" ? "✽" : " "}] Detected
              project folders: {proposal.formattingScopeRoots?.join(", ")}
            </Text>
            <Text>
              [{proposal.formattingScope === "repository" ? "✽" : " "}] Whole
              repository (includes docs and other folders).
            </Text>
          </Box>
        </Box>
      ) : null}
      {proposal.workflowAvailable === true ||
      proposal.workflowMessage !== undefined ? (
        <>
          <BrandedCommandPanelRule width={width} color={color} />
          <Box flexDirection="column" paddingX={2}>
            {proposal.workflowAvailable === true ? (
              <>
                <Box
                  ref={
                    focus === workflowFocusIndex(proposal)
                      ? activeTargetRef
                      : undefined
                  }
                >
                  <Text
                    wrap="wrap"
                    {...colorProp(color, ZEDBEE_THEME.secondary)}
                  >
                    {focus === workflowFocusIndex(proposal) ? "➜ " : "  "}[
                    {proposal.workflow === "github" ? "✽" : " "}] Add GitHub
                    pull-request workflow
                  </Text>
                </Box>
                <Box paddingLeft={2}>
                  <Text
                    wrap="wrap"
                    {...colorProp(color, ZEDBEE_THEME.secondary)}
                  >
                    Create .github/workflows/zedbee.yml to run pull-request
                    scans and upload reports.
                  </Text>
                </Box>
              </>
            ) : null}
            {proposal.workflowMessage === undefined ? null : (
              <Box paddingLeft={2}>
                <Text wrap="wrap" {...colorProp(color, ZEDBEE_THEME.secondary)}>
                  {proposal.workflowMessage}
                </Text>
              </Box>
            )}
          </Box>
        </>
      ) : null}
      <BrandedCommandPanelRule width={width} color={color} />
      <Box
        flexDirection="column"
        paddingX={2}
        ref={
          focus === telemetryFocusIndex(proposal) ? activeTargetRef : undefined
        }
      >
        <Text bold {...colorProp(color, ZEDBEE_THEME.primary)}>
          Tracking
        </Text>
        <Text {...colorProp(color, ZEDBEE_THEME.secondary)}>
          {focus === telemetryFocusIndex(proposal) ? "➜ " : "  "}[
          {proposal.telemetryEnabled !== false ? "✽" : " "}] Enable usage
          tracking
        </Text>
        <Box paddingLeft={2} flexDirection="column">
          <Text wrap="wrap" {...colorProp(color, ZEDBEE_THEME.secondary)}>
            Share usage, issue types and AI tool detection to improve Swarm
          </Text>
          {proposal.telemetryDisabledByEnvironment ? (
            <Text wrap="wrap" {...colorProp(color, ZEDBEE_THEME.muted)}>
              Disabled by your environment settings.
            </Text>
          ) : null}
        </Box>
      </Box>
      <Text> </Text>
      <InitActionButton
        label="REVIEW CHANGES"
        focused={focus === reviewFocusIndex(proposal)}
        activeTargetRef={activeTargetRef}
        color={color}
      />
      <Text> </Text>
      <Box paddingX={2}>
        <Text wrap="wrap" {...colorProp(color, ZEDBEE_THEME.muted)}>
          ↑↓ Move · ←→ Change profile/choice · Space Select · Enter Review · Esc
          Cancel
        </Text>
      </Box>
      <Text> </Text>
    </BrandedCommandPanel>
  );
}

export function ReviewPanel({
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
        <Text wrap="wrap">
          ESLint:{" "}
          {proposal.eslintEngine === "project"
            ? "project (experimental)"
            : "built-in"}
          ; project messages: {proposal.projectEslintMessages ?? "redacted"}
        </Text>
        <Text wrap="wrap">
          Formatting scope:{" "}
          {proposal.formattingScope === "projects"
            ? proposal.formattingScopeRoots?.join(", ") || "whole repository"
            : "whole repository"}
        </Text>
        {proposal.workflowAvailable === true ? (
          <Text wrap="wrap">
            GitHub pull-request workflow:{" "}
            {proposal.workflow === "github" ? "add" : "none"}
          </Text>
        ) : null}
        {proposal.workflowMessage === undefined ? null : (
          <Text wrap="wrap" {...colorProp(color, ZEDBEE_THEME.secondary)}>
            {proposal.workflowMessage}
          </Text>
        )}
        <Text wrap="wrap" {...colorProp(color, ZEDBEE_THEME.secondary)}>
          Stage the configuration and other setup files after applying; checks
          use staged configuration.
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
            {proposal.hooksPathChange !== undefined &&
            !file.relativePath.startsWith(".husky/_/") ? (
              <Text wrap="wrap">{file.diff}</Text>
            ) : null}
          </Box>
          {index < proposal.files.length - 1 ? (
            <BrandedCommandPanelRule width={width} color={color} />
          ) : null}
        </Box>
      ))}
      <Box paddingX={2} marginY={1}>
        <Text {...colorProp(color, ZEDBEE_THEME.secondary)}>
          Usage tracking:{" "}
          {proposal.telemetryEnabled !== false ? "enabled" : "disabled"} (this
          installation)
        </Text>
      </Box>
      <InitActionButton label="APPLY CHANGES" focused color={color} />
      {proposal.hooksPathChange === undefined ? null : (
        <Box paddingX={2}>
          <Text wrap="wrap">
            Activate Git hooks: core.hooksPath →{" "}
            {proposal.hooksPathChange.after}. Commit the tracked hook and
            installer files to share them with teammates.
          </Text>
        </Box>
      )}
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
