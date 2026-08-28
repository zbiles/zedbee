import { useEffect, useRef, useState, type RefObject } from "react";
import {
  Box,
  measureElement,
  Text,
  render,
  useApp,
  useInput,
  useStdout,
  useWindowSize,
  type DOMElement,
} from "ink";
import { FIX_PLAN_FILE_SUMMARY_LIMIT, type FixPlan } from "../fixes/types.js";
import type { FixPromptOptions } from "../commands/fix.js";
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
import { disableTerminalMouse, enableTerminalMouse } from "./terminal-mouse.js";
import { colorProp, ZEDBEE_THEME } from "./theme.js";

const CURSOR_HOME = "\u001b[H";
const SGR_MOUSE_REPORT = /(?:\u001b)?\[<\d+;\d+;\d+[Mm]/u;
const FIX_EVENT_MAX_FPS = 30;

export interface FixAppProps extends FixPromptOptions {
  readonly plan: FixPlan;
  readonly terminalSize?: Readonly<{ columns: number; rows: number }>;
  readonly reportPath?: string;
  onDecision(decision: boolean): void;
  readonly onMouseCleanupReady?: (cleanup: () => void) => void;
}

export function fixMaxFps(): number {
  return FIX_EVENT_MAX_FPS;
}

export function fixRenderOptions() {
  let homeTemporaryScreen = true;
  return Object.freeze({
    exitOnCtrlC: false,
    patchConsole: false,
    maxFps: fixMaxFps(),
    alternateScreen: true,
    onRender() {
      if (!homeTemporaryScreen) return;
      homeTemporaryScreen = false;
      process.stdout.write(CURSOR_HOME);
    },
  });
}

export function isFixCancellationInput(
  input: string,
  key: Readonly<{ ctrl?: boolean; escape?: boolean }>,
): boolean {
  return (
    input === "\u0003" ||
    (key.ctrl === true && input.toLowerCase() === "c") ||
    key.escape === true
  );
}

function countLabel(count: number, singular: string): string {
  const plural =
    singular === "fix"
      ? "fixes"
      : singular === "blocking" || singular === "skipped"
        ? singular
        : `${singular}s`;
  return `${count} ${count === 1 ? singular : plural}`;
}

function FixActionButton({
  label,
  focused,
  activeTargetRef,
  compact = false,
  color,
}: {
  readonly label: string;
  readonly focused: boolean;
  readonly activeTargetRef?: RefObject<DOMElement | null>;
  readonly compact?: boolean;
  readonly color: boolean;
}) {
  return (
    <Box ref={focused ? activeTargetRef : undefined}>
      <Box
        borderStyle="single"
        paddingX={compact ? 1 : 2}
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

function PlanSummary({
  plan,
  reportPath,
  color,
}: {
  readonly plan: FixPlan;
  readonly reportPath?: string;
  readonly color: boolean;
}) {
  const unstaged = plan.files.filter((file) => file.hasUnstagedChanges).length;
  return (
    <Box flexDirection="column" paddingX={2}>
      <Text> </Text>
      <Text wrap="wrap" {...colorProp(color, ZEDBEE_THEME.secondary)}>
        Review the planned managed fixes before Zedbee changes working files.
      </Text>
      <Text> </Text>
      <Text wrap="wrap" {...colorProp(color, ZEDBEE_THEME.secondary)}>
        Checks: {plan.selectedChecks.join(", ") || "none"}
      </Text>
      <Text bold {...colorProp(color, ZEDBEE_THEME.primary)}>
        {countLabel(plan.summary.fixes, "fix")} across{" "}
        {countLabel(plan.summary.files, "file")}
      </Text>
      <Text wrap="wrap" {...colorProp(color, ZEDBEE_THEME.secondary)}>
        <Text
          {...colorProp(
            color,
            plan.summary.blocking > 0
              ? ZEDBEE_THEME.failure
              : ZEDBEE_THEME.pass,
          )}
        >
          {countLabel(plan.summary.blocking, "blocking")}
        </Text>
        {" · "}
        <Text
          {...colorProp(
            color,
            plan.summary.warnings > 0
              ? ZEDBEE_THEME.warning
              : ZEDBEE_THEME.pass,
          )}
        >
          {countLabel(plan.summary.warnings, "warning")}
        </Text>
        {" · "}
        <Text {...colorProp(color, ZEDBEE_THEME.secondary)}>
          {countLabel(plan.summary.skipped, "skipped")}
        </Text>
      </Text>
      {unstaged > 0 ? (
        <Text wrap="wrap" {...colorProp(color, ZEDBEE_THEME.warning)}>
          {countLabel(unstaged, "file")} {unstaged === 1 ? "has" : "have"}{" "}
          unstaged work.
        </Text>
      ) : null}
      {reportPath === undefined ? null : (
        <Text wrap="wrap" {...colorProp(color, ZEDBEE_THEME.muted)}>
          Complete plan: {reportPath}
        </Text>
      )}
      <Text> </Text>
    </Box>
  );
}

function FileSummaries({
  plan,
  width,
  reportPath,
  color,
}: {
  readonly plan: FixPlan;
  readonly width: number;
  readonly reportPath?: string;
  readonly color: boolean;
}) {
  const files =
    reportPath === undefined
      ? plan.files
      : plan.files.slice(0, FIX_PLAN_FILE_SUMMARY_LIMIT);
  return (
    <>
      {files.map((file, index) => {
        const items = plan.items.filter((item) => item.file === file.path);
        const applicableItems = items.filter(
          (item) => item.status !== "skipped",
        );
        const skippedItems = items.filter((item) => item.status === "skipped");
        const blocking = applicableItems.reduce(
          (count, item) => count + item.blocking,
          0,
        );
        const warnings = applicableItems.reduce(
          (count, item) => count + item.warnings,
          0,
        );
        const applicableFixes =
          file.applicableFixes ??
          (items.some((item) => item.status !== undefined)
            ? applicableItems.length
            : file.fixes);
        return (
          <Box key={file.path} flexDirection="column">
            <Box flexDirection="column" paddingX={2}>
              <Text
                bold
                wrap="wrap"
                {...colorProp(color, ZEDBEE_THEME.primary)}
              >
                {file.path}
              </Text>
              {applicableFixes > 0 && file.hasUnstagedChanges ? (
                <Text wrap="wrap" {...colorProp(color, ZEDBEE_THEME.warning)}>
                  APPLY —
                  {applicableItems.some((item) => item.checkId === "formatting")
                    ? " format current working file (includes unstaged changes)"
                    : " exact fixes preserve unrelated unstaged changes"}
                </Text>
              ) : applicableFixes > 0 ? (
                <Text wrap="wrap" {...colorProp(color, ZEDBEE_THEME.secondary)}>
                  APPLY — {countLabel(applicableFixes, "fix")}
                  {blocking > 0 ? ` · ${countLabel(blocking, "blocking")}` : ""}
                  {warnings > 0 ? ` · ${countLabel(warnings, "warning")}` : ""}
                </Text>
              ) : null}
              {skippedItems.map((item) => (
                <Text
                  key={`${item.checkId}:${item.findingIds.join(":")}`}
                  wrap="wrap"
                  {...colorProp(color, ZEDBEE_THEME.failure)}
                >
                  SKIP — {item.reason ?? "Managed exact fix is unavailable."}
                </Text>
              ))}
              <Text> </Text>
            </Box>
            {index < files.length - 1 ? (
              <BrandedCommandPanelRule width={width} color={color} />
            ) : null}
          </Box>
        );
      })}
      {reportPath !== undefined && plan.files.length > files.length ? (
        <Box paddingX={2} paddingBottom={1}>
          <Text wrap="wrap" {...colorProp(color, ZEDBEE_THEME.muted)}>
            Showing {files.length} of {plan.files.length} planned files. See the
            complete plan for the rest.
          </Text>
        </Box>
      ) : null}
    </>
  );
}

function checkStatusLabel(
  status: NonNullable<FixPlan["checks"]>[number]["status"],
  compact: boolean,
): string {
  if (status === "completed") return "READY";
  if (status === "incomplete") return "INCOMPLETE";
  return compact ? "N/A" : "NOT APPLICABLE";
}

function checkStatusTone(
  status: NonNullable<FixPlan["checks"]>[number]["status"],
): string {
  if (status === "completed") return ZEDBEE_THEME.pass;
  if (status === "incomplete") return ZEDBEE_THEME.failure;
  return ZEDBEE_THEME.muted;
}

function CheckStatusPanel({
  plan,
  width,
  color,
}: {
  readonly plan: FixPlan;
  readonly width: number;
  readonly color: boolean;
}) {
  if (plan.checks === undefined || plan.checks.length === 0) return null;
  const compact = width < 48;
  return (
    <BrandedCommandPanel title="CHECK STATUS" width={width} color={color}>
      {plan.checks.map((check, index) => (
        <Box key={check.checkId} flexDirection="column">
          <Box paddingX={2}>
            <Text bold {...colorProp(color, ZEDBEE_THEME.primary)}>
              {check.checkId}
            </Text>
            <Box flexGrow={1} minWidth={1}>
              <Text> </Text>
            </Box>
            <Text bold {...colorProp(color, checkStatusTone(check.status))}>
              {checkStatusLabel(check.status, compact)}
            </Text>
          </Box>
          <Box flexDirection="column" paddingX={2}>
            {check.status === "completed" ? (
              <Text wrap="wrap" {...colorProp(color, ZEDBEE_THEME.secondary)}>
                {countLabel(check.fixes, "fix")} available
              </Text>
            ) : check.status === "not-applicable" ? (
              <Text wrap="wrap" {...colorProp(color, ZEDBEE_THEME.secondary)}>
                {check.reason ?? "No applicable target was found."}
              </Text>
            ) : check.issues.length === 0 ? (
              <Text wrap="wrap" {...colorProp(color, ZEDBEE_THEME.secondary)}>
                The check could not finish.
              </Text>
            ) : (
              check.issues.map((issue) => (
                <Box
                  key={`${issue.code}:${issue.path ?? ""}`}
                  flexDirection="column"
                >
                  <Text
                    wrap="wrap"
                    {...colorProp(color, ZEDBEE_THEME.secondary)}
                  >
                    {issue.message}
                  </Text>
                  {issue.path === undefined ? null : (
                    <Text wrap="wrap" {...colorProp(color, ZEDBEE_THEME.muted)}>
                      Path: {issue.path}
                    </Text>
                  )}
                  {issue.remediation === undefined ? null : (
                    <Text
                      wrap="wrap"
                      {...colorProp(color, ZEDBEE_THEME.warning)}
                    >
                      Remediation: {issue.remediation}
                    </Text>
                  )}
                </Box>
              ))
            )}
          </Box>
          {index < plan.checks!.length - 1 ? (
            <BrandedCommandPanelRule width={width} color={color} />
          ) : null}
        </Box>
      ))}
      <BrandedCommandPanelRule width={width} color={color} />
      <Box paddingX={2}>
        <Text wrap="wrap" {...colorProp(color, ZEDBEE_THEME.secondary)}>
          No files have been changed.
        </Text>
      </Box>
      <Text> </Text>
    </BrandedCommandPanel>
  );
}

function FixPlanPanel({
  plan,
  width,
  reportPath,
  color,
}: {
  readonly plan: FixPlan;
  readonly width: number;
  readonly reportPath?: string;
  readonly color: boolean;
}) {
  return (
    <BrandedCommandPanel title="FIX PLAN" width={width} color={color}>
      <PlanSummary
        plan={plan}
        {...(reportPath === undefined ? {} : { reportPath })}
        color={color}
      />
      <BrandedCommandPanelRule width={width} color={color} />
      <FileSummaries
        plan={plan}
        width={width}
        {...(reportPath === undefined ? {} : { reportPath })}
        color={color}
      />
      <Text> </Text>
    </BrandedCommandPanel>
  );
}

function FixActions({
  hasApplicableFixes,
  focus,
  activeTargetRef,
  width,
  color,
}: {
  readonly hasApplicableFixes: boolean;
  readonly focus: number;
  readonly activeTargetRef: RefObject<DOMElement | null>;
  readonly width: number;
  readonly color: boolean;
}) {
  const compact = width < 48;
  return (
    <Box flexDirection="column" width={width}>
      <Box justifyContent="center">
        {hasApplicableFixes ? (
          <>
            <FixActionButton
              label="APPLY FIXES"
              focused={focus === 0}
              activeTargetRef={activeTargetRef}
              compact={compact}
              color={color}
            />
            <Box width={compact ? 1 : 3} />
            <FixActionButton
              label="CANCEL"
              focused={focus === 1}
              activeTargetRef={activeTargetRef}
              compact={compact}
              color={color}
            />
          </>
        ) : (
          <FixActionButton
            label="CLOSE"
            focused
            activeTargetRef={activeTargetRef}
            color={color}
          />
        )}
      </Box>
      <Text> </Text>
      <Box paddingX={2}>
        <Text wrap="wrap" {...colorProp(color, ZEDBEE_THEME.muted)}>
          {hasApplicableFixes
            ? "Tab/←→ Focus · Space/Enter Activate · Esc Cancel · PgUp/PgDn Scroll"
            : "Space/Enter Close · Esc Close · PgUp/PgDn Scroll"}
        </Text>
      </Box>
      <Text> </Text>
    </Box>
  );
}

export function FixApp(props: FixAppProps) {
  const {
    plan,
    width,
    terminalSize,
    color,
    reportPath,
    onDecision,
    onMouseCleanupReady,
  } = props;
  const { exit } = useApp();
  const { stdout } = useStdout();
  const liveSize = useWindowSize();
  const columns = terminalSize?.columns ?? liveSize.columns ?? width;
  const rows = terminalSize?.rows ?? liveSize.rows ?? 24;
  const [focus, setFocus] = useState(0);
  const [offset, setOffset] = useState(0);
  const [viewportMetrics, setViewportMetrics] =
    useState<TerminalViewportMetrics>({
      contentHeight: 0,
      visibleHeight: rows,
    });
  const activeTargetRef = useRef<DOMElement>(null);
  const hasApplicableFixes =
    plan.items.some((item) => item.status !== "skipped") || plan.exitCode !== 1;
  const contentRef = useRef<DOMElement>(null);
  const offsetRef = useRef(offset);
  const lastRevealRef = useRef<
    Readonly<{ columns: number; rows: number; focus: number }> | undefined
  >(undefined);
  offsetRef.current = offset;

  useEffect(() => {
    const cleanup = enableTerminalMouse(stdout);
    onMouseCleanupReady?.(cleanup);
    return cleanup;
  }, [onMouseCleanupReady, stdout]);

  useEffect(() => {
    const previous = lastRevealRef.current;
    if (
      previous?.columns === columns &&
      previous.rows === rows &&
      previous.focus === focus
    ) {
      return;
    }
    lastRevealRef.current = { columns, rows, focus };
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
    const nextOffset = minimalRevealOffset(
      offsetRef.current,
      visibleHeight,
      targetBounds.y - contentBounds.y,
      targetBounds.height,
      contentBounds.height,
    );
    if (nextOffset !== offsetRef.current) setOffset(nextOffset);
  }, [columns, focus, rows]);

  const decide = (decision: boolean): void => {
    onDecision(decision);
    exit();
  };
  const scrollBy = (delta: number): void => {
    setOffset((current) =>
      clampScrollOffset(
        current + delta,
        viewportMetrics.contentHeight,
        viewportMetrics.visibleHeight,
      ),
    );
  };

  useInput((input, key) => {
    const wheelDelta = parseSgrWheelDelta(input);
    if (SGR_MOUSE_REPORT.test(input)) {
      if (wheelDelta !== 0) scrollBy(wheelDelta);
      return;
    }
    if (isFixCancellationInput(input, key)) {
      decide(false);
      return;
    }
    if (key.pageUp || key.pageDown) {
      scrollBy(
        (key.pageDown ? 1 : -1) * pageScrollStep(viewportMetrics.visibleHeight),
      );
      return;
    }
    if (key.tab || key.leftArrow || key.rightArrow) {
      if (hasApplicableFixes) setFocus((current) => (current + 1) % 2);
      return;
    }
    if (key.upArrow || key.downArrow) {
      if (viewportMetrics.contentHeight > viewportMetrics.visibleHeight) {
        scrollBy(key.downArrow ? 1 : -1);
      } else {
        if (hasApplicableFixes) setFocus((current) => (current + 1) % 2);
      }
      return;
    }
    if (key.return || input === " ") decide(hasApplicableFixes && focus === 0);
  });

  return (
    <TerminalViewport
      width={columns}
      height={rows}
      offset={offset}
      color={color}
      contentRef={contentRef}
      onOffsetChange={setOffset}
      onMetricsChange={setViewportMetrics}
    >
      <BrandedCommandFrame width={columns} color={color}>
        <Box flexDirection="column">
          <FixPlanPanel
            plan={plan}
            width={brandedCommandContentWidth(columns)}
            {...(reportPath === undefined ? {} : { reportPath })}
            color={color}
          />
          {plan.checks === undefined || plan.checks.length === 0 ? null : (
            <>
              <Text> </Text>
              <CheckStatusPanel
                plan={plan}
                width={brandedCommandContentWidth(columns)}
                color={color}
              />
            </>
          )}
          <Text> </Text>
          <FixActions
            hasApplicableFixes={hasApplicableFixes}
            focus={focus}
            activeTargetRef={activeTargetRef}
            width={brandedCommandContentWidth(columns)}
            color={color}
          />
        </Box>
      </BrandedCommandFrame>
    </TerminalViewport>
  );
}

export async function runFixPrompt(
  plan: FixPlan,
  options: FixPromptOptions,
): Promise<boolean> {
  options.signal?.throwIfAborted();
  let decision = false;
  let cleanupMouse = () => disableTerminalMouse(process.stdout);
  let app: ReturnType<typeof render> | undefined;
  const abort = (): void => {
    app?.unmount();
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    options.signal?.throwIfAborted();
    app = render(
      <FixApp
        plan={plan}
        {...options}
        onDecision={(value) => {
          decision = value;
        }}
        onMouseCleanupReady={(cleanup) => {
          cleanupMouse = cleanup;
        }}
      />,
      fixRenderOptions(),
    );
    if (options.signal?.aborted === true) abort();
    await app.waitUntilExit();
    options.signal?.throwIfAborted();
    return decision;
  } finally {
    options.signal?.removeEventListener("abort", abort);
    cleanupMouse();
  }
}
