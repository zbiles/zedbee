export const terminalMouseSequences = Object.freeze({
  enable: "\u001b[?1000h\u001b[?1006h",
  disable: "\u001b[?1006l\u001b[?1000l",
});

interface TerminalWriter {
  write(value: string): unknown;
}

export function disableTerminalMouse(stdout: TerminalWriter): void {
  stdout.write(terminalMouseSequences.disable);
}

export function enableTerminalMouse(stdout: TerminalWriter): () => void {
  stdout.write(terminalMouseSequences.enable);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    disableTerminalMouse(stdout);
  };
}
