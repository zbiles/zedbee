import type { ReactNode } from "react";
import { Box } from "ink";
import { PixelBee, pixelBeeWidth } from "./pixel-bee.js";
import { PixelWordmark, pixelWordmarkWidth } from "./pixel-wordmark.js";
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
  const brandGroupWidth = brandWidth + 2 + pixelBeeWidth(compactBrand);

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
          borderBackgroundColor="#000000"
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
              height={5}
              justifyContent="center"
              marginTop={2}
              marginBottom={2}
            >
              <Box position="relative" width={brandGroupWidth} height={5}>
                <PixelWordmark color={color} compact={compactBrand} />
                <Box position="absolute" left={brandWidth + 2} top={-5}>
                  <PixelBee compact={compactBrand} sparse color={color} />
                </Box>
              </Box>
            </Box>
            {children}
          </Box>
        </Box>
      </Box>
    </Box>
  );
}
