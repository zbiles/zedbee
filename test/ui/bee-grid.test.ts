import { describe, expect, it } from "vitest";
import {
  BEE_GRID,
  MIRRORED_STINGER_ROW,
  MOTION_DASHES,
  mirrorBee,
  motionDashGrid
} from "../../src/ui/bee-grid.js";

const expectedBee = [
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
];

describe("Zedbee pixel asset", () => {
  it("preserves the exact approved bee grid", () => {
    expect(BEE_GRID).toEqual(expectedBee);
  });

  it("mirrors every row without redrawing the asset", () => {
    expect(mirrorBee(BEE_GRID)).toEqual(
      expectedBee.map((row) => [...row].reverse().join(""))
    );
  });

  it("uses three four-cell dashes aligned to the mirrored stinger row", () => {
    expect(MOTION_DASHES).toEqual([
      { startColumn: 0, row: 7, cells: 4 },
      { startColumn: 6, row: 7, cells: 4 },
      { startColumn: 12, row: 7, cells: 4 }
    ]);
    expect(MOTION_DASHES.every((dash) => dash.cells === 4)).toBe(true);
    expect(MOTION_DASHES.every((dash) => dash.row === MIRRORED_STINGER_ROW)).toBe(true);
    expect(motionDashGrid()[7]).toBe("yyyy00yyyy00yyyy");
  });
});
