import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { Box, Text, useBoxMetrics, type DOMElement } from "ink";
import { clampScrollOffset } from "./terminal-viewport-model.js";
import { colorProp, ZEDBEE_THEME } from "./theme.js";

export interface TerminalViewportMetrics {
  readonly contentHeight: number;
  readonly visibleHeight: number;
}

export interface TerminalViewportProps {
  readonly width: number;
  readonly height: number;
  readonly offset: number;
  readonly color: boolean;
  readonly children: ReactNode;
  readonly contentRef?: RefObject<DOMElement | null>;
  onOffsetChange(offset: number): void;
  onMetricsChange?(metrics: TerminalViewportMetrics): void;
}

interface IndicatorRowProps {
  readonly width: number;
  readonly color: boolean;
  readonly children?: ReactNode;
}

interface ClampRequest {
  readonly offset: number;
  readonly contentHeight: number;
  readonly visibleHeight: number;
  readonly requestedOffset: number;
}

function IndicatorRow({ width, color, children }: IndicatorRowProps) {
  return (
    <Box
      width={width}
      height={1}
      minHeight={1}
      flexShrink={0}
      justifyContent="center"
    >
      {children === undefined ? null : (
        <Text dimColor={color} {...colorProp(color, ZEDBEE_THEME.yellow)}>
          {children}
        </Text>
      )}
    </Box>
  );
}

export function TerminalViewport({
  width,
  height,
  offset,
  color,
  children,
  contentRef,
  onOffsetChange,
  onMetricsChange,
}: TerminalViewportProps) {
  const fallbackContentRef = useRef<DOMElement>(null);
  const measuredContentRef = contentRef ?? fallbackContentRef;
  const measuredContent = useBoxMetrics(measuredContentRef);
  const terminalWidth = Math.max(1, Math.trunc(width));
  const terminalHeight = Math.max(1, Math.trunc(height));
  const contentHeight = measuredContent.height;
  const overflows =
    measuredContent.hasMeasured && contentHeight > terminalHeight;
  const showIndicators = overflows && terminalHeight >= 3;
  const visibleHeight = showIndicators
    ? Math.max(1, terminalHeight - 2)
    : terminalHeight;
  const clampedOffset = clampScrollOffset(offset, contentHeight, visibleHeight);
  const previousMetrics = useRef<TerminalViewportMetrics | undefined>(
    undefined,
  );
  const previousClampRequest = useRef<ClampRequest | undefined>(undefined);

  useEffect(() => {
    if (!measuredContent.hasMeasured) return;
    if (clampedOffset === offset) {
      previousClampRequest.current = undefined;
      return;
    }
    const previous = previousClampRequest.current;
    if (
      previous?.offset === offset &&
      previous.contentHeight === contentHeight &&
      previous.visibleHeight === visibleHeight &&
      previous.requestedOffset === clampedOffset
    ) {
      return;
    }
    previousClampRequest.current = {
      offset,
      contentHeight,
      visibleHeight,
      requestedOffset: clampedOffset,
    };
    onOffsetChange(clampedOffset);
  }, [
    clampedOffset,
    contentHeight,
    measuredContent.hasMeasured,
    offset,
    onOffsetChange,
    visibleHeight,
  ]);

  useEffect(() => {
    if (!measuredContent.hasMeasured || onMetricsChange === undefined) return;
    const previous = previousMetrics.current;
    if (
      previous?.contentHeight === contentHeight &&
      previous.visibleHeight === visibleHeight
    ) {
      return;
    }
    const metrics = { contentHeight, visibleHeight };
    previousMetrics.current = metrics;
    onMetricsChange(metrics);
  }, [
    contentHeight,
    measuredContent.hasMeasured,
    onMetricsChange,
    visibleHeight,
  ]);

  const content = (
    <Box
      ref={measuredContentRef}
      position="absolute"
      width={terminalWidth}
      flexDirection="column"
      flexShrink={0}
      marginTop={-clampedOffset}
    >
      {children}
    </Box>
  );

  if (!showIndicators) {
    return (
      <Box
        width={terminalWidth}
        height={terminalHeight}
        flexDirection="column"
        overflowX="hidden"
        overflowY="hidden"
      >
        {content}
      </Box>
    );
  }

  const hasMoreAbove = clampedOffset > 0;
  const hasMoreBelow = clampedOffset + visibleHeight < contentHeight;
  const aboveIndicator = terminalWidth >= 12 ? "↑ MORE ABOVE" : "↑";
  const belowIndicator = terminalWidth >= 12 ? "↓ MORE BELOW" : "↓";

  return (
    <Box
      width={terminalWidth}
      height={terminalHeight}
      flexDirection="column"
      overflowX="hidden"
    >
      <IndicatorRow width={terminalWidth} color={color}>
        {hasMoreAbove ? aboveIndicator : undefined}
      </IndicatorRow>
      <Box
        width={terminalWidth}
        height={visibleHeight}
        flexShrink={0}
        overflowX="hidden"
        overflowY="hidden"
      >
        {content}
      </Box>
      <IndicatorRow width={terminalWidth} color={color}>
        {hasMoreBelow ? belowIndicator : undefined}
      </IndicatorRow>
    </Box>
  );
}
