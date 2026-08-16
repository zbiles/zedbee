const ZEDBEE_COMMAND = "npx --no-install zedbee scan";
const ZEDBEE_SCAN_COMMAND =
  /(?:^|[\n;&|])\s*(?:npx(?:\s+--no-install)?\s+)?(?:\.\/node_modules\/\.bin\/)?zedbee\s+scan(?:\s|$)/u;

export function hasZedbeeScanCommand(source: string): boolean {
  return ZEDBEE_SCAN_COMMAND.test(source);
}

export function updateHuskyHook(before: string | null | undefined): string {
  const source = before ?? "#!/bin/sh\n";
  if (hasZedbeeScanCommand(source)) return source;
  const hadFinalNewline = source.endsWith("\n");
  const lines = source.split("\n");
  if (hadFinalNewline) lines.pop();
  let insertion = lines.length;
  while (insertion > 0 && lines[insertion - 1]?.trim() === "") insertion -= 1;
  if (/^exit(?:\s|$)/u.test(lines[insertion - 1]?.trim() ?? "")) {
    insertion -= 1;
  }
  lines.splice(insertion, 0, ZEDBEE_COMMAND);
  return `${lines.join("\n")}\n`;
}
