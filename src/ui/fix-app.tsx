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
  const plural = singular === "fix" ? "fixes" : `${singular}s`;
  return `${count} ${count === 1 ? singular : plural}`;
}

function FixActionButton({
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
          {focused ? "➜ " : "  "}
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
        {plan.summary.fixes} fixes across {plan.summary.files} files
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
  color,
}: {
  readonly plan: FixPlan;
  readonly width: number;
  readonly color: boolean;
}) {
  const files = plan.files.slice(0, FIX_PLAN_FILE_SUMMARY_LIMIT);
  return (
    <>
      {files.map((file, index) => {
        const items = plan.items.filter((item) => item.file === file.path);
        const blocking = items.reduce(
          (count, item) => count + item.blocking,
          0,
        );
        const warnings = items.reduce(
          (count, item) => count + item.warnings,
          0,
        );
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
              {file.hasUnstagedChanges ? (
                <Text wrap="wrap" {...colorProp(color, ZEDBEE_THEME.warning)}>
                  APPLY —
                  {items.some((item) => item.checkId === "formatting")
                    ? " format current working file (includes unstaged changes)"
                    : " exact fixes preserve unrelated unstaged changes"}
                </Text>
              ) : (
                <Text wrap="wrap" {...colorProp(color, ZEDBEE_THEME.secondary)}>
                  APPLY — {countLabel(file.fixes, "fix")}
                  {blocking > 0 ? ` · ${countLabel(blocking, "blocking")}` : ""}
                  {warnings > 0 ? ` · ${countLabel(warnings, "warning")}` : ""}
                </Text>
              )}
              <Text> </Text>
            </Box>
            {index < files.length - 1 ? (
              <BrandedCommandPanelRule width={width} color={color} />
            ) : null}
          </Box>
        );
      })}
      {plan.files.length > files.length ? (
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

function FixPlanPanel({
  plan,
  width,
  reportPath,
  focus,
  activeTargetRef,
  color,
}: {
  readonly plan: FixPlan;
  readonly width: number;
  readonly reportPath?: string;
  readonly focus: number;
  readonly activeTargetRef: RefObject<DOMElement | null>;
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
      <FileSummaries plan={plan} width={width} color={color} />
      <Text> </Text>
      <FixActionButton
        label="APPLY FIXES"
        focused={focus === 0}
        activeTargetRef={activeTargetRef}
        color={color}
      />
      <Text> </Text>
      <FixActionButton
        label="CANCEL"
        focused={focus === 1}
        activeTargetRef={activeTargetRef}
        color={color}
      />
      <Text> </Text>
      <Box paddingX={2}>
        <Text wrap="wrap" {...colorProp(color, ZEDBEE_THEME.muted)}>
          Tab/←→ Focus · Space/Enter Activate · Esc Cancel · PgUp/PgDn Scroll
        </Text>
      </Box>
      <Text> </Text>
    </BrandedCommandPanel>
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
      setFocus((current) =>
        key.leftArrow ? (current + 1) % 2 : (current + 1) % 2,
      );
      return;
    }
    if (key.upArrow || key.downArrow) {
      if (viewportMetrics.contentHeight > viewportMetrics.visibleHeight) {
        scrollBy(key.downArrow ? 1 : -1);
      } else {
        setFocus((current) => (current + 1) % 2);
      }
      return;
    }
    if (key.return || input === " ") decide(focus === 0);
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
        <FixPlanPanel
          plan={plan}
          width={brandedCommandContentWidth(columns)}
          {...(reportPath === undefined ? {} : { reportPath })}
          focus={focus}
          activeTargetRef={activeTargetRef}
          color={color}
        />
      </BrandedCommandFrame>
    </TerminalViewport>
  );
}

export async function runFixPrompt(
  plan: FixPlan,
  options: FixPromptOptions,
): Promise<boolean> {
  let decision = false;
  let cleanupMouse = () => disableTerminalMouse(process.stdout);
  try {
    const app = render(
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
    await app.waitUntilExit();
    return decision;
  } finally {
    cleanupMouse();
  }
}
