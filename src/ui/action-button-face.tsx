import { Box, Text } from "ink";
import { ZEDBEE_THEME } from "./theme.js";

export function ActionButtonFace({
  label,
  focused,
  padding = 2,
  color,
}: {
  label: string;
  focused: boolean;
  padding?: number;
  color: boolean;
}) {
  return (
    <Box
      borderStyle="single"
      paddingX={padding}
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
  );
}
