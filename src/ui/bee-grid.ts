export const BEE_GRID = [
  "000ww00ww0",
  "00www0wwww",
  "00www0wwww",
  "000ww0www0",
  "000ybyby00",
  "0yyybybyb0",
  "ybyybybyby",
  "yyyybybybb",
  "yyyybybyby",
  "0yyybybyb0",
  "000ybyby00"
] as const;

export const LOGICAL_PIXEL_COLUMNS = 2;
export const MIRRORED_STINGER_ROW = 7;

export const MOTION_DASHES = [
  { startColumn: 0, row: 7, cells: 4 },
  { startColumn: 6, row: 7, cells: 4 },
  { startColumn: 12, row: 7, cells: 4 }
] as const;

export function mirrorBee(grid: readonly string[]): string[] {
  return grid.map((row) => [...row].reverse().join(""));
}

export function motionDashGrid(): string[] {
  const width = Math.max(...MOTION_DASHES.map((dash) => dash.startColumn + dash.cells));
  return BEE_GRID.map((_, row) => {
    const cells = Array.from({ length: width }, () => "0");
    for (const dash of MOTION_DASHES) {
      if (dash.row === row) {
        cells.fill("y", dash.startColumn, dash.startColumn + dash.cells);
      }
    }
    return cells.join("");
  });
}
