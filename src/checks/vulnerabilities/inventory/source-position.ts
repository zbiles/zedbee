export interface SourcePositionIndex {
  readonly lineAt: (offset: number) => number;
}

export function createSourcePositionIndex(contents: string): SourcePositionIndex {
  const lineStarts = [0];
  for (let index = 0; index < contents.length; index += 1) {
    if (contents.charCodeAt(index) === 10) lineStarts.push(index + 1);
  }
  return Object.freeze({
    lineAt(offset: number): number {
      let low = 0;
      let high = lineStarts.length;
      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if ((lineStarts[middle] ?? 0) <= offset) low = middle + 1;
        else high = middle;
      }
      return Math.max(1, low);
    },
  });
}
