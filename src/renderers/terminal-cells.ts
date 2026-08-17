const graphemeSegmenter = new Intl.Segmenter("en", {
  granularity: "grapheme",
});

function graphemes(value: string): string[] {
  return Array.from(graphemeSegmenter.segment(value), ({ segment }) => segment);
}

function isWideCodePoint(codePoint: number): boolean {
  return (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    codePoint === 0x2329 ||
    codePoint === 0x232a ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff01 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1b000 && codePoint <= 0x1b2ff) ||
    (codePoint >= 0x1f200 && codePoint <= 0x1f251) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  );
}

function graphemeWidth(grapheme: string): number {
  if (
    /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20e3/iu.test(grapheme)
  ) {
    return 2;
  }
  let width = 0;
  for (const point of grapheme) {
    if (/\p{Mark}/u.test(point) || point === "\u200d" || point === "\ufe0f") {
      continue;
    }
    const codePoint = point.codePointAt(0)!;
    width += isWideCodePoint(codePoint) ? 2 : 1;
  }
  return width;
}

export function terminalCellWidth(value: string): number {
  return graphemes(value).reduce(
    (width, grapheme) => width + graphemeWidth(grapheme),
    0,
  );
}

export function chunkTerminalCells(value: string, width: number): string[] {
  const available = Math.max(1, width);
  const chunks: string[] = [];
  let current = "";
  let currentWidth = 0;
  for (const grapheme of graphemes(value)) {
    const nextWidth = graphemeWidth(grapheme);
    if (nextWidth > available) {
      if (current !== "") chunks.push(current);
      chunks.push("…");
      current = "";
      currentWidth = 0;
    } else if (currentWidth + nextWidth > available) {
      chunks.push(current);
      current = grapheme;
      currentWidth = nextWidth;
    } else {
      current += grapheme;
      currentWidth += nextWidth;
    }
  }
  if (current !== "" || chunks.length === 0) chunks.push(current);
  return chunks;
}

export function wrapTerminalWords(value: string, width: number): string[] {
  const available = Math.max(1, width);
  const words = value.trim().split(/\s+/u).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words.flatMap((item) =>
    chunkTerminalCells(item, available),
  )) {
    if (current === "") {
      current = word;
    } else if (
      terminalCellWidth(current) + 1 + terminalCellWidth(word) <=
      available
    ) {
      current += ` ${word}`;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current !== "" || lines.length === 0) lines.push(current);
  return lines;
}

export function padStartTerminalCells(value: string, width: number): string {
  return `${" ".repeat(Math.max(0, width - terminalCellWidth(value)))}${value}`;
}

export function truncateTerminalCells(value: string, width: number): string {
  const available = Math.max(1, width);
  if (terminalCellWidth(value) <= available) return value;
  if (available === 1) return "…";
  const contentWidth = available - 1;
  let content = "";
  let used = 0;
  for (const grapheme of graphemes(value)) {
    const nextWidth = graphemeWidth(grapheme);
    if (used + nextWidth > contentWidth) break;
    content += grapheme;
    used += nextWidth;
  }
  return `${content}…`;
}
