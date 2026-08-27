import type { ReactNode } from "react";
import { Box, Text } from "ink";
import { PixelBee, pixelBeeWidth } from "./pixel-bee.js";
import {
  PlainWordmark,
  PixelWordmark,
  pixelWordmarkHeight,
  pixelWordmarkWidth,
} from "./pixel-wordmark.js";
import { ZEDBEE_THEME } from "./theme.js";

const SOLID_BORDER = {
  top: "█",
  bottom: "█",
  left: "█",
  right: "█",
  topLeft: "█",
  topRight: "█",
  bottomLeft: "█",
  bottomRight: "█",
} as const;

export function brandedCommandContentWidth(width: number): number {
  return Math.max(1, width - 9);
}

export function BrandedCommandPanelRule({
  width,
  color,
}: {
  readonly width: number;
  readonly color: boolean;
}) {
  return (
    <Box marginX={-1}>
      <Text {...(color ? { color: ZEDBEE_THEME.border } : {})}>├</Text>
      <Text {...(color ? { color: ZEDBEE_THEME.border } : {})}>
        {"─".repeat(Math.max(1, width - 2))}
      </Text>
      <Text {...(color ? { color: ZEDBEE_THEME.border } : {})}>┤</Text>
    </Box>
  );
}

export function BrandedCommandPanel({
  title,
  width,
  color,
  children,
}: {
  readonly title: string;
  readonly width: number;
  readonly color: boolean;
  readonly children: ReactNode;
}) {
  return (
    <Box
      flexDirection="column"
      width={width}
      borderStyle="single"
      {...(color
        ? {
            borderColor: ZEDBEE_THEME.border,
            borderBackgroundColor: "#000000",
          }
        : {})}
    >
      <Box paddingX={2}>
        <Text {...(color ? { color: ZEDBEE_THEME.muted } : {})}>{title}</Text>
      </Box>
      <BrandedCommandPanelRule width={width} color={color} />
      {children}
    </Box>
  );
}

export function BrandedCommandFrame({
  width,
  color,
  children,
}: {
  readonly width: number;
  readonly color: boolean;
  readonly children: ReactNode;
}) {
  const frameWidth = Math.max(1, width - 2);
  const compactBrand = width < 129;
  const brandWidth = pixelWordmarkWidth(compactBrand);
  const beeWidth = pixelBeeWidth(compactBrand);
  const availableBrandWidth = Math.max(1, frameWidth - 7);
  const showWordmark = brandWidth <= availableBrandWidth;
  const narrowFrame = !showWordmark;
  const showBee =
    showWordmark && brandWidth + 2 + beeWidth <= availableBrandWidth;
  const brandHeight = narrowFrame ? 3 : pixelWordmarkHeight(compactBrand);
  const beeTop = 0;
  const brandGroupWidth = showWordmark
    ? brandWidth + (showBee ? 2 + beeWidth : 0)
    : Math.min(availableBrandWidth, 6);

  return (
    <Box width={width} paddingLeft={1} paddingRight={1} paddingTop={2}>
      <Box
        width={frameWidth}
        {...(color ? { backgroundColor: "#000000" } : {})}
      >
        <Box
          flexDirection="column"
          width={frameWidth}
          borderStyle={SOLID_BORDER}
          {...(color ? { borderColor: ZEDBEE_THEME.yellow } : {})}
          borderBackgroundColor={color ? "#000000" : undefined}
        >
          <Box
            flexDirection="column"
            width={frameWidth - 2}
            borderStyle={SOLID_BORDER}
            borderTop={false}
            borderBottom={false}
            {...(color ? { borderColor: ZEDBEE_THEME.yellow } : {})}
            paddingLeft={2}
            paddingRight={1}
            paddingBottom={1}
          >
            <Box
              height={brandHeight}
              justifyContent="center"
              marginTop={2}
              marginBottom={2}
            >
              <Box
                position="relative"
                width={brandGroupWidth}
                height={brandHeight}
              >
                {showWordmark ? (
                  <PixelWordmark color={color} compact={compactBrand} />
                ) : (
                  <PlainWordmark color={color} />
                )}
                {showBee ? (
                  <Box position="absolute" left={brandWidth + 2} top={beeTop}>
                    <PixelBee compact={compactBrand} sparse color={color} />
                  </Box>
                ) : null}
              </Box>
            </Box>
            {children}
          </Box>
        </Box>
      </Box>
    </Box>
  );
}
