import { describe, expect, it } from "vitest";
import { createManagedEslint } from "../../../src/checks/eslint/load-engine.js";

const ruleId = "react-hooks/set-state-in-effect";
const engine = createManagedEslint({
  cwd: process.cwd(),
  mode: "react-correctness",
  reactVersion: "19.0.0",
  managedIgnores: [],
});

async function findings(source: string) {
  const results = await engine.lintText(source, {
    filePath: "src/async-effect-regression.tsx",
  });
  const messages = results.flatMap((result) => result.messages);
  expect(messages.filter((message) => message.fatal)).toEqual([]);
  return messages.filter((message) => message.ruleId === ruleId);
}

function component(helper: string, effect: string): string {
  return `
import { useState, useCallback, useEffect } from "react";
export function useExample({ enabled, authFetch, promise }) {
  const [value, setValue] = useState(0);
  const [loading, setLoading] = useState(true);
  const read = useCallback(async () => { ${helper} }, [enabled, authFetch, promise]);
  useEffect(() => {
    let live = true;
    ${effect}
    return () => { live = false; };
  }, [read]);
  return { value, loading };
}
`;
}

const invocationForms = [
  ["then", "void read().then(() => { if (live) setLoading(false); });"],
  [
    "await wrapper",
    "void (async () => { await read(); if (live) setLoading(false); })();",
  ],
] as const;

describe("managed synchronous state updates across async effect helpers", () => {
  for (const [name, helper, shouldReport] of [
    ["only after await", "await Promise.resolve(); setValue(1);", false],
    ["before first await", "setValue(1); await Promise.resolve();", true],
    [
      "after an await on both branches",
      "if (enabled) { await 0; } else { await 1; } setValue(1);",
      false,
    ],
    [
      "after a conditional await",
      "if (enabled) { await 0; } setValue(1);",
      true,
    ],
    [
      "on a synchronous branch before await",
      "if (enabled) { setValue(1); return; } await 0;",
      true,
    ],
    [
      "in an awaited rejection handler",
      "try { await promise; } catch { setValue(1); }",
      false,
    ],
    [
      "in a catch reachable before suspension",
      "try { await authFetch(); } catch { setValue(1); }",
      true,
    ],
    [
      "while evaluating an awaited argument",
      "await authFetch(setValue(1));",
      true,
    ],
    [
      "in finally after suspension",
      "try { await 0; } finally { setValue(1); }",
      false,
    ],
  ] as const) {
    for (const [form, effect] of invocationForms) {
      it(`${shouldReport ? "reports" : "allows"} updates ${name} via ${form}`, async () => {
        const messages = await findings(component(helper, effect));
        if (shouldReport) {
          expect(messages.length).toBeGreaterThan(0);
          expect(messages.every((message) => message.severity === 2)).toBe(
            true,
          );
        } else {
          expect(messages).toEqual([]);
        }
      });
    }
  }

  it("reports a direct synchronous effect update", async () => {
    expect(
      (await findings(component("return 42;", "setValue(1);"))).length,
    ).toBeGreaterThan(0);
  });

  for (const method of ["then", "catch"] as const) {
    it(`allows a promise ${method} callback`, async () => {
      expect(
        await findings(
          component("return 42;", `void promise.${method}(() => setValue(1));`),
        ),
      ).toEqual([]);
    });
  }

  it("allows a synchronous setter in cleanup only", async () => {
    const source = component("return 42;", "").replace(
      "return () => { live = false; };",
      "return () => { live = false; setValue(1); };",
    );
    expect(await findings(source)).toEqual([]);
  });
});
