export function clampScrollOffset(
  offset: number,
  contentHeight: number,
  viewportHeight: number,
): number {
  return Math.min(
    Math.max(0, Math.trunc(offset)),
    Math.max(0, Math.trunc(contentHeight) - Math.max(1, Math.trunc(viewportHeight))),
  );
}

export function pageScrollStep(viewportHeight: number): number {
  return Math.max(1, Math.trunc(viewportHeight) - 2);
}

export function minimalRevealOffset(
  offset: number,
  viewportHeight: number,
  targetTop: number,
  targetHeight: number,
  contentHeight: number,
): number {
  const visibleHeight = Math.max(1, Math.trunc(viewportHeight));
  const current = clampScrollOffset(offset, contentHeight, visibleHeight);
  const top = Math.max(0, Math.trunc(targetTop));
  const height = Math.max(1, Math.trunc(targetHeight));
  if (top < current) return clampScrollOffset(top, contentHeight, visibleHeight);
  const targetBottom = top + height;
  if (targetBottom > current + visibleHeight) {
    return clampScrollOffset(
      height > visibleHeight ? top : targetBottom - visibleHeight,
      contentHeight,
      visibleHeight,
    );
  }
  return current;
}

const SGR_MOUSE = /(?:\u001b)?\[<(\d+);\d+;\d+[Mm]/gu;

export function parseSgrWheelDelta(input: string): number {
  let delta = 0;
  for (const match of input.matchAll(SGR_MOUSE)) {
    const code = Number(match[1]);
    if (code === 64) delta -= 3;
    if (code === 65) delta += 3;
  }
  return delta;
}
