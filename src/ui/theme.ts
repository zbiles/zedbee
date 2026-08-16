export const ZEDBEE_THEME = {
  primary: "#e7e9ef",
  secondary: "#9298a5",
  muted: "#656c78",
  border: "#484e59",
  wordmark: "#b18cf7",
  yellow: "#fecd23",
  pass: "#55cf82",
  warning: "#e8b84c",
  failure: "#ef6559",
  wing: "#f3f4f6",
  beeBlack: "#2e2e2e",
} as const;

export function colorProp(enabled: boolean, color: string): { color?: string } {
  return enabled ? { color } : {};
}
