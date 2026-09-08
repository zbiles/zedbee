import { describe, expect, it } from "vitest";
import * as ts from "typescript";
import { collectChangedEntities } from "../../src/attribution/entities.js";

describe("collectChangedEntities", () => {
  it("assigns constructors the canonical instance-member identity", () => {
    const [constructor] = collectChangedEntities(
      "class Worker { constructor() { work(); } }",
      "src/worker.ts",
      [{ start: 1, end: 1 }],
    ).filter(({ name }) => name === "constructor");

    expect(constructor).toMatchObject({
      kind: "method",
      name: "constructor",
      identity:
        "method:src/worker.ts:class=Worker/member-scope=instance/member-role=constructor/method=constructor",
    });
  });

  it("assigns structural identities to callbacks and class-field functions", () => {
    const entities = collectChangedEntities(
      "export function outer(xs: number[]) { return xs.map(x => x ? 1 : 0); } class Worker { task = () => work(); }",
      "src/functions.ts",
      [{ start: 1, end: 1 }],
    );

    expect(entities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "function",
          name: expect.stringMatching(/^anonymous@/u),
          identity: expect.stringMatching(
            /function=outer\/function=anonymous%40/u,
          ),
        }),
        expect.objectContaining({
          kind: "function",
          name: "task",
          identity: expect.stringContaining(
            "member-scope=instance/member-role=field/function=task",
          ),
        }),
      ]),
    );
  });

  it("distinguishes same-named members in separate inline object literals", () => {
    const methods = collectChangedEntities(
      "consume({ run(){ if (a) work(); } }, { run(){ if (a) { if (b) work(); } } });",
      "src/objects.ts",
      [{ start: 1, end: 1 }],
    ).filter(({ name }) => name === "run");

    expect(methods).toHaveLength(2);
    expect(new Set(methods.map(({ identity }) => identity)).size).toBe(2);
    expect(
      methods.every(({ identity }) => identity.includes("object-scope=")),
    ).toBe(true);
  });

  it("keeps an anonymous function entity for unresolved computed properties", () => {
    const entities = collectChangedEntities(
      'const key = "run"; export const value = { [key]: () => ready ? 1 : 0 };',
      "value.ts",
      [{ start: 1, end: 1 }],
    );

    expect(entities).toContainEqual({
      kind: "function",
      name: "anonymous@1.1.0.1.0.1",
      file: "value.ts",
      startLine: 1,
      endLine: 1,
      identity:
        "function:value.ts:variable=value/function=anonymous%401.1.0.1.0.1",
    });
  });

  it("distinguishes duplicate same-named class-field functions", () => {
    const fields = collectChangedEntities(
      "class Worker { task = () => ready ? 1 : 0; task = () => fallback ? 1 : 0; }",
      "src/fields.ts",
      [{ start: 1, end: 1 }],
    ).filter(({ name }) => name === "task");

    expect(fields).toHaveLength(2);
    expect(new Set(fields.map(({ identity }) => identity)).size).toBe(2);
    expect(
      fields.every(({ identity }) => identity.includes("field-scope=")),
    ).toBe(true);
  });
  it("uses the supported TypeScript compiler API shared with typed linting", () => {
    expect(typeof ts.createSourceFile).toBe("function");

    expect(
      collectChangedEntities(
        "class Profile { get name() { return 'zedbee'; } }",
        "src/profile.ts",
        [{ start: 1, end: 1 }],
      ),
    ).toEqual([
      expect.objectContaining({
        kind: "class",
        name: "Profile",
        identity: "class:src/profile.ts:Profile",
      }),
      expect.objectContaining({
        kind: "method",
        name: "name",
        identity:
          "method:src/profile.ts:class=Profile/member-scope=instance/member-role=get/method=name",
      }),
    ]);
  });

  it("owns a changed branch with the enclosing declaration's full span", () => {
    const source = [
      "export function parseOrder(value: string) {",
      "  if (value.length === 0) {",
      "    return undefined;",
      "  }",
      "  return value;",
      "}",
    ].join("\n");

    expect(
      collectChangedEntities(source, "src/parser.ts", [{ start: 3, end: 3 }]),
    ).toEqual([
      {
        kind: "function",
        name: "parseOrder",
        file: "src/parser.ts",
        startLine: 1,
        endLine: 6,
        identity: "function:src/parser.ts:parseOrder",
      },
    ]);
  });

  it("collects methods, arrows, classes, default exports, and JSX components deterministically", () => {
    const source = [
      "export class Parser {",
      "  parse() { return 1; }",
      "}",
      "export const Button = () => <button />;",
      "export default function () { return <Button />; }",
    ].join("\n");

    expect(
      collectChangedEntities(source, "src/ui.tsx", [{ start: 1, end: 5 }]).map(
        ({ kind, name, startLine, endLine }) => ({
          kind,
          name,
          startLine,
          endLine,
        }),
      ),
    ).toEqual([
      { kind: "class", name: "Parser", startLine: 1, endLine: 3 },
      { kind: "method", name: "parse", startLine: 2, endLine: 2 },
      { kind: "function", name: "Button", startLine: 4, endLine: 4 },
      { kind: "function", name: "default", startLine: 5, endLine: 5 },
    ]);
  });

  it.each(["js", "jsx", "ts", "tsx"])(
    "parses .%s without typechecking or executing it",
    (extension) => {
      const source = extension.includes("x")
        ? "const View = () => <MissingComponent />;"
        : extension === "ts"
          ? "const run = (value: MissingType) => value;"
          : "const run = (value) => value;";
      const [entity] = collectChangedEntities(
        source,
        `src/input.${extension}`,
        [{ start: 1, end: 1 }],
      );

      expect(entity).toMatchObject({
        kind: "function",
        startLine: 1,
        endLine: 1,
      });
    },
  );

  it("collects nested owners and does not collect declarations outside the changed range", () => {
    const source = [
      "function outer() {",
      "  function inner() {",
      "    return true;",
      "  }",
      "  return inner();",
      "}",
      "function untouched() { return false; }",
    ].join("\n");

    expect(
      collectChangedEntities(source, "src/nested.js", [
        { start: 3, end: 3 },
      ]).map(({ name }) => name),
    ).toEqual(["outer", "inner"]);
    expect(
      collectChangedEntities(source, "src/nested.js", [{ start: 7, end: 7 }]),
    ).toEqual([expect.objectContaining({ name: "untouched" })]);
  });

  it("distinguishes repeated names by lexical owner without line-based identity", () => {
    const source = [
      "class Alpha {",
      "  parse() {",
      "    function visit() { return 1; }",
      "    return visit();",
      "  }",
      "}",
      "class Beta {",
      "  parse() {",
      "    function visit() { return 2; }",
      "    return visit();",
      "  }",
      "}",
    ].join("\n");
    const entities = collectChangedEntities(source, "src/owners.ts", [
      { start: 1, end: 12 },
    ]);
    const repeated = entities.filter(
      ({ name }) => name === "parse" || name === "visit",
    );

    expect(repeated.map(({ identity }) => identity)).toEqual([
      "method:src/owners.ts:class=Alpha/member-scope=instance/member-role=method/method=parse",
      "function:src/owners.ts:class=Alpha/member-scope=instance/member-role=method/method=parse/function=visit",
      "method:src/owners.ts:class=Beta/member-scope=instance/member-role=method/method=parse",
      "function:src/owners.ts:class=Beta/member-scope=instance/member-role=method/method=parse/function=visit",
    ]);
    expect(new Set(repeated.map(({ identity }) => identity)).size).toBe(4);
    expect(
      repeated.every(({ identity }) => !/:\d+(?:$|\/)/u.test(identity)),
    ).toBe(true);
  });

  it("distinguishes same-named instance accessors by semantic role", () => {
    const source = [
      "class Profile {",
      "  get name() { return this.value; }",
      "  set name(value: string) { this.value = value; }",
      "  private value = '';",
      "}",
    ].join("\n");

    const accessors = collectChangedEntities(source, "src/profile.ts", [
      { start: 2, end: 3 },
    ]).filter(({ name }) => name === "name");

    expect(accessors.map(({ identity }) => identity)).toEqual([
      "method:src/profile.ts:class=Profile/member-scope=instance/member-role=get/method=name",
      "method:src/profile.ts:class=Profile/member-scope=instance/member-role=set/method=name",
    ]);
    expect(new Set(accessors.map(({ identity }) => identity)).size).toBe(2);
  });

  it("distinguishes same-named static and instance methods", () => {
    const source = [
      "class Parser {",
      "  parse() { return 'instance'; }",
      "  static parse() { return 'static'; }",
      "}",
    ].join("\n");

    const methods = collectChangedEntities(source, "src/parser.ts", [
      { start: 2, end: 3 },
    ]).filter(({ name }) => name === "parse");

    expect(methods.map(({ identity }) => identity)).toEqual([
      "method:src/parser.ts:class=Parser/member-scope=instance/member-role=method/method=parse",
      "method:src/parser.ts:class=Parser/member-scope=static/member-role=method/method=parse",
    ]);
    expect(new Set(methods.map(({ identity }) => identity)).size).toBe(2);
  });

  it("skips TypeScript overload signatures and keeps executable implementation identities stable", () => {
    const source = [
      "function convert(value: string): string;",
      "function convert(value: number): number;",
      "function convert(value: string | number) { return value; }",
      "class Converter {",
      "  convert(value: string): string;",
      "  convert(value: number): number;",
      "  convert(value: string | number) { return value; }",
      "}",
    ].join("\n");

    const entities = collectChangedEntities(source, "src/convert.ts", [
      { start: 1, end: 8 },
    ]).filter(({ name }) => name === "convert");

    expect(
      entities.map(({ identity, startLine, endLine }) => ({
        identity,
        startLine,
        endLine,
      })),
    ).toEqual([
      {
        identity: "function:src/convert.ts:convert",
        startLine: 3,
        endLine: 3,
      },
      {
        identity:
          "method:src/convert.ts:class=Converter/member-scope=instance/member-role=method/method=convert",
        startLine: 7,
        endLine: 7,
      },
    ]);
  });

  it("returns immutable canonical data without retaining source text", () => {
    const secret = "DO_NOT_REPORT_THIS_SOURCE";
    const entities = collectChangedEntities(
      `function safe() { return ${JSON.stringify(secret)}; }`,
      "./src\\safe.ts",
      [{ start: 1, end: 1 }],
    );

    expect(Object.isFrozen(entities)).toBe(true);
    expect(Object.isFrozen(entities[0])).toBe(true);
    expect(entities[0]?.file).toBe("src/safe.ts");
    expect(JSON.stringify(entities)).not.toContain(secret);
  });

  it("fails closed for unsupported paths, invalid ranges, and syntax errors", () => {
    expect(() =>
      collectChangedEntities("function ok() {}", "src/input.vue", [
        { start: 1, end: 1 },
      ]),
    ).toThrow(TypeError);
    expect(() =>
      collectChangedEntities("function ok() {}", "../input.ts", [
        { start: 1, end: 1 },
      ]),
    ).toThrow(TypeError);
    expect(() =>
      collectChangedEntities("function ok() {}", "src/input.ts", [
        { start: 0, end: 1 },
      ]),
    ).toThrow(TypeError);
    expect(() =>
      collectChangedEntities("function ok() {}", "src/input.ts", [
        { start: 2, end: 2 },
      ]),
    ).toThrow(TypeError);
    expect(() =>
      collectChangedEntities("function broken( {", "src/input.ts", [
        { start: 1, end: 1 },
      ]),
    ).toThrow(SyntaxError);
  });

  it("uses code-unit ordering without consulting the host locale", () => {
    const original = String.prototype.localeCompare;
    String.prototype.localeCompare = () => {
      throw new Error("locale ordering must not be consulted");
    };
    try {
      const entities = collectChangedEntities(
        "const zulu = () => 1; const alpha = () => 2;",
        "src/order.ts",
        [{ start: 1, end: 1 }],
      );
      expect(entities.map(({ name }) => name)).toEqual(["alpha", "zulu"]);
    } finally {
      String.prototype.localeCompare = original;
    }
  });
});
