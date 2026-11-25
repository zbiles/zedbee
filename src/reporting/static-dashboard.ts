export function useStaticDashboard(
  format: "auto" | "text" | "json",
  {
    stdoutIsTTY,
    width,
    env,
  }: {
    stdoutIsTTY: boolean;
    width: number;
    env: Readonly<Record<string, string | undefined>>;
  },
): boolean {
  return (
    format === "auto" &&
    stdoutIsTTY &&
    width >= 80 &&
    env.TERM !== "dumb" &&
    env.CI === undefined
  );
}
