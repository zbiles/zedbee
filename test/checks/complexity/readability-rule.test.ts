import { describe, expect, it } from "vitest";
import {
  scoreReadabilityComplexities,
  scoreReadabilityComplexity,
} from "../../../src/checks/complexity/readability-rule.js";

describe("scoreReadabilityComplexity", () => {
  it.each([
    [
      "nested decisions include their current nesting",
      "function f(){ if (a) { if (b) work(); } }",
      3,
    ],
    [
      "a contiguous logical chain counts once per chain",
      "function f(){ return a && b || c; }",
      2,
    ],
    [
      "catch is one decision",
      "function f(){ try { work(); } catch { recover(); } }",
      1,
    ],
    [
      "else-if does not add extra nesting",
      "function f(){ if (a) work(); else if (b) recover(); }",
      2,
    ],
    [
      "loops are decisions",
      "function f(){ for (;;) break; while (a) break; do work(); while (b); }",
      3,
    ],
    [
      "switches are decisions",
      "function f(){ switch (a) { case 1: break; default: break; } }",
      1,
    ],
    [
      "conditional expressions are decisions",
      "function f(){ return a ? b : c; }",
      1,
    ],
  ])("%s", (_name, source, expected) => {
    expect(scoreReadabilityComplexity(source)).toBe(expected);
  });

  it("resets nesting and score at nested function boundaries", () => {
    expect(
      scoreReadabilityComplexities(
        "function outer(){ if (a) { const inner = () => { if (b) { if (c) work(); } }; } }",
      ).sort((left, right) => left - right),
    ).toEqual([1, 3]);
  });
});
