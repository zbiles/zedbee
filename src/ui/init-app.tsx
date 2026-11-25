import {
  SetupPanel,
  ReviewPanel,
  FORMATTING_CHOICES,
  SECONDARY_FORMATTING_CHOICES,
  hookFocusCount,
  formattingFocusIndex,
  hasFormattingScope,
  workflowFocusIndex,
  telemetryFocusIndex,
  reviewFocusIndex,
} from "./init-view.js";
export { PROJECT_PRETTIER_DISCLOSURE, InitActionButton } from "./init-view.js";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  measureElement,
  Text,
  render,
  useApp,
  useInput,
  useStdout,
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
import type { InitSelection } from "../init/selection-policy.js";
import type {
  InitFormattingChoice,
  InitFormattingScope,
  EvaluatedExecutableImports,
  InitHookChoice,
  InitOsvUnavailable,
  InitProposal,
  InitWorkflowChoice,
} from "../init/types.js";
import {
  brandedCommandContentWidth,
  BrandedCommandFrame,
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
import { disableTerminalMouse, enableTerminalMouse } from "./terminal-mouse.js";
import { InitOperation, type InitOperationState } from "./init-operation.js";

export interface InitAppProps extends InitPromptOptions {
  readonly proposal: InitProposal;
  readonly terminalSize?: Readonly<{ columns: number; rows: number }>;
  readonly proposalForSelection: (selection: InitSelection) => InitProposal;
  /** Present only when an executable configuration can be consented evaluated. */
  readonly evaluateExecutableImport?: (
    signal: AbortSignal,
  ) => Promise<EvaluatedExecutableImports | undefined>;
  onDecision(decision: false | InitProposal): void;
  readonly prepareReview?: (proposal: InitProposal) => Promise<InitProposal>;
  readonly onMouseCleanupReady?: (cleanup: () => void) => void;
}

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

export function InitApp({
  proposal,
  proposalForSelection,
  evaluateExecutableImport,
  projectPrettierTrustStored,
  width,
  terminalSize,
  color,
  onDecision,
  onMouseCleanupReady,
  prepareReview,
}: InitAppProps) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const liveSize = useWindowSize();
  const columns = terminalSize?.columns ?? liveSize.columns ?? width;
  const rows = terminalSize?.rows ?? liveSize.rows ?? 24;
  const [eslintEngine, setEslintEngine] = useState<
    "managed" | "project" | undefined
  >();
  const [eslintTrust, setEslintTrust] = useState(
    proposal.projectEslintTrustConfirmed === true,
  );
  const [eslintMessages, setEslintMessages] = useState<boolean | undefined>();
  const [eslintMessageTrust, setEslintMessageTrust] = useState(
    proposal.projectEslintMessagesConfirmed === true,
  );
  const effectiveEslintEngine =
    eslintEngine ?? proposal.eslintEngine ?? "managed";
  const [telemetryEnabled, setTelemetryEnabled] = useState(
    proposal.telemetryDisabledByEnvironment !== true &&
      proposal.telemetryEnabled !== false,
  );
  const [phase, setPhase] = useState<"configure" | "review">("configure");
  const [focus, setFocus] = useState(0);
  const [scope, setScope] = useState<InitFormattingScope>(
    proposal.formattingScope ?? "repository",
  );
  const [workflow, setWorkflow] = useState<InitWorkflowChoice>(
    proposal.workflow ?? "none",
  );
  const [preparedReview, setPreparedReview] = useState<InitProposal>();
  const [preparingReview, setPreparingReview] = useState(false);
  const [reviewError, setReviewError] = useState<string>();
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  const [setupOffset, setSetupOffset] = useState(0);
  const [reviewOffset, setReviewOffset] = useState(0);
  const [viewportMetrics, setViewportMetrics] =
    useState<TerminalViewportMetrics>({
      contentHeight: 0,
      visibleHeight: rows,
    });
  const [baseProfile, setBaseProfile] = useState<ProfileId>(proposal.profile);
  const [customized, setCustomized] = useState(false);
  const [hookSelection, setHookSelection] = useState<InitHookChoice>(
    proposal.hookSelection ?? proposal.hook,
  );
  const [selected, setSelected] = useState(
    () => new Set<CheckId>(proposal.recommendedChecks),
  );
  const [osvUnavailable, setOsvUnavailable] = useState<InitOsvUnavailable>(
    proposal.osvUnavailable,
  );
  const [formatting, setFormatting] = useState<
    InitFormattingChoice | undefined
  >(undefined);
  const [projectTrust, setProjectTrust] = useState(
    projectPrettierTrustStored === true ||
      proposal.projectPrettierTrustConfirmed === true,
  );
  const [evaluationState, setEvaluationState] = useState<InitOperationState>({
    status: "idle",
  });
  const [evaluation] = useState(
    () =>
      new InitOperation<EvaluatedExecutableImports | undefined>(
        setEvaluationState,
      ),
  );
  useEffect(() => () => evaluation.dispose(), [evaluation]);
  const [evaluatedImport, setEvaluatedImport] = useState<
    EvaluatedExecutableImports | undefined
  >(undefined);
  const effectiveFormatting: InitFormattingChoice =
    formatting ?? proposal.formatting ?? "managed";
  const formattingDetected = (proposal.formattingDetection?.length ?? 0) > 0;
  const canEvaluateExecutable = evaluateExecutableImport !== undefined;
  const executableEvaluationAvailable =
    canEvaluateExecutable && effectiveFormatting === "copy";
  const projectTrustRequired =
    effectiveFormatting === "project" && !projectTrust;
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
  const selectedProposal = useMemo(
    () => ({
      ...proposalForSelection({
        profile: baseProfile,
        eslintEngine,
        eslintTrust,
        eslintMessages,
        eslintMessageTrust,
        checks: Object.freeze(CHECK_IDS.filter((check) => selected.has(check))),
        osvUnavailable,
        hook: hookSelection,
        formatting,
        projectTrust,
        evaluatedImport,
        scope,
        workflow,
      }),
      telemetryEnabled,
      telemetryDisabledByEnvironment:
        proposal.telemetryDisabledByEnvironment === true,
    }),
    [
      eslintEngine,
      eslintTrust,
      eslintMessages,
      eslintMessageTrust,
      telemetryEnabled,
      proposal.telemetryDisabledByEnvironment,
      baseProfile,
      osvUnavailable,
      hookSelection,
      formatting,
      projectTrust,
      evaluatedImport,
      proposalForSelection,
      selected,
      scope,
      workflow,
    ],
  );
  const reviewedProposal =
    phase === "review"
      ? (preparedReview ?? selectedProposal)
      : selectedProposal;
  const eslintReviewBlocked =
    effectiveEslintEngine === "project" &&
    (!eslintTrust ||
      (selectedProposal.projectEslintMessages === "full" &&
        !eslintMessageTrust) ||
      (selectedProposal.eslintConflicts?.length ?? 0) > 0);
  const beginReview = () => {
    if (eslintReviewBlocked) return;
    evaluation.cancel();
    if (prepareReview === undefined) {
      setPhase("review");
      return;
    }
    setPreparingReview(true);
    setReviewError(undefined);
    void prepareReview(selectedProposal)
      .then((value) => {
        if (mounted.current) {
          setPreparedReview(value);
          setPhase("review");
        }
      })
      .catch((cause: unknown) => {
        if (mounted.current)
          setReviewError(
            cause instanceof Error
              ? cause.message
              : "Could not prepare setup review.",
          );
      })
      .finally(() => {
        if (mounted.current) setPreparingReview(false);
      });
  };
  const hookRows = hookFocusCount(reviewedProposal);

  useEffect(() => {
    const cleanup = enableTerminalMouse(stdout);
    onMouseCleanupReady?.(cleanup);
    return cleanup;
  }, [onMouseCleanupReady, stdout]);

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
    // Leaving the evaluation action invalidates its result immediately, before
    // any state update or review can observe a late formatter completion.
    if (normalized !== "e") evaluation.cancel();
    if (preparingReview) {
      if (key.escape) {
        onDecision(false);
        exit();
      }
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

    if (normalized === "l") {
      setEslintEngine((value) =>
        (value ?? proposal.eslintEngine ?? "managed") === "managed"
          ? "project"
          : "managed",
      );
    } else if (normalized === "x" && effectiveEslintEngine === "project") {
      setEslintTrust((value) => !value);
    } else if (normalized === "m" && effectiveEslintEngine === "project") {
      const next = !(
        eslintMessages ?? proposal.projectEslintMessages === "full"
      );
      setEslintMessages(next);
      setEslintMessageTrust(next);
    } else if (key.return) {
      if (projectTrustRequired) {
        // The executable-code disclosure must be confirmed separately.
        return;
      }
      beginReview();
    } else if (
      (normalized === "t" &&
        (effectiveFormatting === "project" || executableEvaluationAvailable)) ||
      (normalized === "e" &&
        executableEvaluationAvailable &&
        projectTrust &&
        evaluateExecutableImport !== undefined)
    ) {
      if (normalized === "t") {
        setProjectTrust((value) => !value);
      } else {
        evaluation.start(evaluateExecutableImport!, setEvaluatedImport);
      }
    } else if (normalized === "n" || key.escape) {
      onDecision(false);
      exit();
    } else if (key.upArrow) {
      const focusCount = reviewFocusIndex(reviewedProposal) + 1;
      setFocus((value) => (value - 1 + focusCount) % focusCount);
    } else if (key.downArrow) {
      const focusCount = reviewFocusIndex(reviewedProposal) + 1;
      setFocus((value) => (value + 1) % focusCount);
    } else if (
      hookRows > 0 &&
      focus === 1 &&
      (input === " " || key.leftArrow || key.rightArrow)
    ) {
      setHookSelection((value) =>
        value === "none"
          ? proposal.hookChoices!.find((choice) => choice !== "none")!
          : "none",
      );
    } else if (
      hookRows === 2 &&
      focus === 2 &&
      (input === " " || key.leftArrow || key.rightArrow)
    ) {
      setHookSelection((value) => (value === "tracked" ? "raw" : "tracked"));
    } else if (focus === 0 && (key.leftArrow || key.rightArrow)) {
      const currentIndex = PROFILE_IDS.indexOf(baseProfile);
      const offset = key.rightArrow ? 1 : -1;
      const nextProfile =
        PROFILE_IDS[
          (currentIndex + offset + PROFILE_IDS.length) % PROFILE_IDS.length
        ]!;
      const nextProposal = proposalForSelection({
        profile: nextProfile,
        eslintEngine,
        eslintTrust,
        eslintMessages,
        eslintMessageTrust,
        osvUnavailable,
        hook: hookSelection,
        formatting,
        projectTrust,
        evaluatedImport,
        scope,
        workflow,
      });
      setBaseProfile(nextProfile);
      setCustomized(false);
      setSelected(new Set(nextProposal.recommendedChecks));
    } else if (
      focus === formattingFocusIndex(reviewedProposal) &&
      (input === " " || key.leftArrow || key.rightArrow)
    ) {
      setFormatting((current) => {
        const visible = formattingDetected
          ? FORMATTING_CHOICES
          : SECONDARY_FORMATTING_CHOICES;
        const base = current ?? proposal.formatting ?? "managed";
        const index = visible.indexOf(base);
        const offset = key.leftArrow ? -1 : 1;
        return visible[(index + offset + visible.length) % visible.length]!;
      });
    } else if (
      hasFormattingScope(reviewedProposal) &&
      focus === formattingFocusIndex(reviewedProposal) + 1 &&
      (input === " " || key.leftArrow || key.rightArrow)
    ) {
      setScope((value) => (value === "projects" ? "repository" : "projects"));
    } else if (
      reviewedProposal.workflowAvailable === true &&
      focus === workflowFocusIndex(reviewedProposal) &&
      (input === " " || key.leftArrow || key.rightArrow)
    ) {
      setWorkflow((value) => (value === "github" ? "none" : "github"));
    } else if (
      focus === telemetryFocusIndex(reviewedProposal) &&
      (input === " " || key.leftArrow || key.rightArrow)
    ) {
      if (!proposal.telemetryDisabledByEnvironment)
        setTelemetryEnabled((value) => !value);
    } else if (input === " ") {
      if (
        proposal.vulnerabilityScanningAvailable &&
        focus === CHECK_IDS.length + 1 + hookRows
      ) {
        setOsvUnavailable("block");
        return;
      }
      if (
        proposal.vulnerabilityScanningAvailable &&
        focus === CHECK_IDS.length + 2 + hookRows
      ) {
        setOsvUnavailable("warn");
        return;
      }
      if (focus === reviewFocusIndex(reviewedProposal)) {
        if (projectTrustRequired) return;
        beginReview();
        return;
      }
      const check = CHECK_IDS[focus - 1 - hookRows];
      if (check !== undefined) {
        if (
          effectiveEslintEngine === "project" &&
          ["reactCorrectness", "reactAccessibility"].includes(check)
        )
          return;
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
        {evaluationState.status === "evaluating" ? (
          <Text>Evaluating executable settings...</Text>
        ) : null}
        {evaluationState.status === "error" ? (
          <Text>{evaluationState.message}</Text>
        ) : null}
        {preparingReview ? <Text>Preparing review...</Text> : null}
        {reviewError === undefined ? null : <Text>{reviewError}</Text>}
        {phase === "configure" ? (
          <SetupPanel
            proposal={reviewedProposal}
            focus={focus}
            profile={customized ? "custom" : baseProfile}
            baseProfile={baseProfile}
            selected={selected}
            osvUnavailable={osvUnavailable}
            formatting={effectiveFormatting}
            detection={proposal.formattingDetection}
            limitations={
              effectiveFormatting === "copy"
                ? (reviewedProposal.formattingImport?.limitations ?? [])
                : []
            }
            trustConfirmed={projectTrust}
            canEvaluateExecutable={canEvaluateExecutable}
            evaluatedExecutable={evaluatedImport !== undefined}
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
  proposalForSelection: (selection: InitSelection) => InitProposal,
  evaluateExecutableImport?: (
    signal: AbortSignal,
  ) => Promise<EvaluatedExecutableImports | undefined>,
  prepareReview?: (proposal: InitProposal) => Promise<InitProposal>,
): Promise<false | InitProposal> {
  let decision: false | InitProposal = false;
  let cleanupMouse = () => disableTerminalMouse(process.stdout);
  try {
    const app = render(
      <InitApp
        proposal={proposal}
        proposalForSelection={proposalForSelection}
        {...(evaluateExecutableImport === undefined
          ? {}
          : { evaluateExecutableImport })}
        {...options}
        {...(prepareReview === undefined ? {} : { prepareReview })}
        onDecision={(value) => {
          decision = value;
        }}
        onMouseCleanupReady={(cleanup) => {
          cleanupMouse = cleanup;
        }}
      />,
      initRenderOptions(),
    );
    await app.waitUntilExit();
    return decision;
  } finally {
    cleanupMouse();
  }
}
