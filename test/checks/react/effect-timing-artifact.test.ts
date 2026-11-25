import { createRequire } from "node:module";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";
const require = createRequire(import.meta.url);
const plugin = require("../../../assets/react-hooks/7.1.1/index.cjs");
const engine = new ESLint({
  overrideConfigFile: true,
  overrideConfig: [
    {
      files: ["**/*.jsx"],
      plugins: { "react-hooks": plugin },
      rules: { "react-hooks/set-state-in-effect": "error" },
    },
  ],
});
const rule = "react-hooks/set-state-in-effect";
async function findings(helper: string, effect: string, hook = "useEffect") {
  const source = `import { useState, useCallback, useEffect, useLayoutEffect, useInsertionEffect, useRef } from 'react';
 export function useExample({ enabled, promise, authFetch }) {
 const [value, setValue] = useState(0); const ref=useRef(null);
 const read = useCallback(async () => { ${helper} }, [enabled,promise,authFetch]);
 ${hook}(() => { ${effect} }, [read]); return value; }`;
  const results = await engine.lintText(source, { filePath: "effect.jsx" });
  expect(results.flatMap((x) => x.messages).filter((x) => x.fatal)).toEqual([]);
  return results.flatMap((x) => x.messages).filter((x) => x.ruleId === rule);
}
const helpers = [
  ["post-await", "await promise; setValue(1);", false],
  ["pre-await", "setValue(1); await promise;", true],
  [
    "both branches await",
    "if(enabled){await 0}else{await 1} setValue(1);",
    false,
  ],
  ["one branch awaits", "if(enabled)await 0; setValue(1);", true],
  ["synchronous branch", "if(enabled){setValue(1);return;} await 0;", true],
  ["promise rejection", "try { await promise; } catch { setValue(1); }", false],
  ["call throws", "try { await authFetch(); } catch { setValue(1); }", true],
  ["awaited argument", "await authFetch(setValue(1));", true],
  [
    "finally after suspension",
    "try { await promise; } finally { setValue(1); }",
    false,
  ],
  ["zero-iteration loop", "while(enabled){await promise;} setValue(1);", true],
  ["await before loop", "await promise; while(enabled){setValue(1);}", false],
  ["early return", "if(enabled)return; await promise; setValue(1);", false],
  [
    "property evaluation throws",
    "try { await promise.value; } catch { setValue(1); }",
    true,
  ],
  [
    "known sync returns captured promise",
    "const f=()=>promise; try { await f(); } catch {setValue(1);}",
    false,
  ],
  [
    "known sync throws",
    "const f=()=>{throw 1}; try { await f(); } catch {setValue(1);}",
    true,
  ],
  [
    "known async rejects",
    "const f=async()=>{throw 1}; try { await f(); } catch {setValue(1);}",
    false,
  ],
  [
    "known async local catch",
    "const f=async()=>{try {throw 1}catch{setValue(1)}}; await f();",
    true,
  ],
  ["unused nested callback", "const f=()=>setValue(1); await promise;", false],
  ["returned callback", "return ()=>setValue(1);", false],
  [
    "local setter alias",
    "const setter=setValue; setter(1); await promise;",
    true,
  ],
  [
    "callee wait does not suspend caller",
    "const f=async()=>{await promise}; f(); setValue(1);",
    true,
  ],
  [
    "reassigned helper becomes safe",
    "let f=()=>setValue(1); f=()=>{}; f(); await promise;",
    false,
  ],
  [
    "reassigned helper becomes immediate",
    "let f=()=>{}; f=()=>setValue(1); f(); await promise;",
    true,
  ],
  [
    "local helper alias",
    "const f=()=>setValue(1); const g=f; g(); await promise;",
    true,
  ],
  [
    "nested immediate wrappers",
    "void(async()=>{void(async()=>{setValue(1); await promise;})();})();",
    true,
  ],
  [
    "nested post-await wrappers",
    "void(async()=>{await promise; void(async()=>{setValue(1);})();})();",
    false,
  ],
  [
    "helper declared after use",
    "f(); function f(){setValue(1)} await promise;",
    true,
  ],
  [
    "recursive helper prefix",
    "function f(){setValue(1); if(enabled)f();} f(); await promise;",
    true,
  ],
  [
    "mutual recursive prefix",
    "function f(){setValue(1); if(enabled)g();} function g(){f();} g(); await promise;",
    true,
  ],
  [
    "thenable awaited getter throws",
    "const t={get then(){throw 1;}}; try{await t;}catch{setValue(1)}",
    false,
  ],
  [
    "custom synchronous then call",
    "const t={then(){setValue(1)}}; t.then(); await promise;",
    true,
  ],
  [
    "nested finally after rejection",
    "try {try {await promise;} finally {}} catch {setValue(1);}",
    false,
  ],
] as const;
describe("corrected artifact follows effect execution timing", () => {
  for (const [name, helper, report] of helpers)
    for (const wrapper of [false, true]) {
      it(`${report ? "reports" : "allows"} ${name} ${wrapper ? "through wrapper" : "directly"}`, async () => {
        const messages = await findings(
          helper,
          wrapper
            ? "void(async()=>{await read()})()"
            : "void read().then(()=>{})",
        );
        expect(messages.length > 0).toBe(report);
        for (const message of messages) {
          expect(message.severity).toBe(2);
          expect(message.line).toBeGreaterThan(0);
        }
      });
    }
  for (const hook of ["useEffect", "useLayoutEffect", "useInsertionEffect"])
    it(`preserves direct ${hook} detection`, async () =>
      expect((await findings("", "setValue(1);", hook)).length).toBeGreaterThan(
        0,
      ));
  for (const method of ["then", "catch"])
    it(`allows native promise ${method} callback`, async () =>
      expect(
        await findings("", `void promise.${method}(()=>setValue(1));`),
      ).toEqual([]));
  it("allows cleanup-only setters", async () =>
    expect(await findings("", "return ()=>setValue(1);")).toEqual([]));
  it("preserves ref-derived exception", async () =>
    expect(await findings("", "setValue(ref.current);")).toEqual([]));
  it("an unused function does not contaminate the next effect", async () =>
    expect(
      await findings("setValue(1);", "void promise.then(()=>{});"),
    ).toEqual([]));
});

it("preserves state updates reached through useEffectEvent", async () => {
  const source = `import {useState,useEffect,useEffectEvent} from 'react'; export function useExample(){const [value,setValue]=useState(0);const update=useEffectEvent(()=>setValue(1)); useEffect(()=>{update()},[]);return value;}`;
  const results = await engine.lintText(source, { filePath: "event.jsx" });
  expect(
    results.flatMap((x) => x.messages).filter((x) => x.ruleId === rule).length,
  ).toBeGreaterThan(0);
});

for (const [name, helper, report] of [
  [
    "internally caught throw",
    "const f=()=>{try{throw 1}catch{}return promise};try{await f()}catch{setValue(1)}",
    false,
  ],
  [
    "ternary helper merge",
    "const a=()=>setValue(1),b=()=>{};const f=enabled?a:b;f();",
    true,
  ],
  [
    "conditional helper assignment",
    "let f=()=>{};if(enabled)f=()=>setValue(1);f();",
    true,
  ],
  [
    "known async object method rejection",
    "const t={async run(){throw 1}};try{await t.run()}catch{setValue(1)}",
    false,
  ],
] as const)
  it(`handles ${name}`, async () =>
    expect((await findings(helper, "void read()")).length > 0).toBe(report));

it("preserves ref-controlled helper exception", async () =>
  expect(
    await findings("", "const f=()=>setValue(1); if(ref.current)f();"),
  ).toEqual([]));
it("preserves ref argument helper exception", async () =>
  expect(await findings("", "const f=n=>setValue(n); f(ref.current);")).toEqual(
    [],
  ));
