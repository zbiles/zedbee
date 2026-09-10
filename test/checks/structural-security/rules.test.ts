import { Lang, parse, SgNode, SgRoot } from "@ast-grep/napi";
import { describe, expect, it, vi } from "vitest";
import {
  collectStructuralSecurityObservations,
  structuralRules,
} from "../../../src/checks/structural-security/rules.js";

describe("collectStructuralSecurityObservations", () => {
  it("keeps AST work linear as repeated imported requests grow", () => {
    const countWork = (requests: number) => {
      const source =
        'import * as http from "node:http";\n' +
        'http.request("http://service.test", { headers: { authorization: token } });\n'.repeat(
          requests,
        );
      const kinds = vi.spyOn(SgNode.prototype, "kind");
      const children = vi.spyOn(SgNode.prototype, "children");
      try {
        const findings = collectStructuralSecurityObservations(
          "src/requests.ts",
          source,
        );
        expect(findings).toHaveLength(requests);
        expect(
          findings.every(
            (finding) => finding.rule === "credential-over-insecure-http",
          ),
        ).toBe(true);
        return kinds.mock.calls.length + children.mock.calls.length;
      } finally {
        kinds.mockRestore();
        children.mockRestore();
      }
    };

    const small = countWork(8);
    const large = countWork(32);
    expect(large).toBeLessThan(small * 5);
  });

  it("preserves exact findings and source ranges across all rules", () => {
    const source = [
      'import { exec } from "node:child_process";',
      'import vm from "node:vm";',
      'import { createHash } from "node:crypto";',
      'import request from "request";',
      "eval(source);",
      "new Function(source);",
      "exec(command);",
      "vm.runInNewContext(source);",
      "({ rejectUnauthorized: false });",
      'createHash("md5").update(password);',
      'request({ url: "http://service.test", token: secret });',
    ].join("\n");
    const findings = collectStructuralSecurityObservations(
      "src/all.ts",
      source,
    );

    expect(
      findings
        .map(({ rule, location }) => ({ rule, location }))
        .sort(
          (left, right) =>
            (left.location?.startLine ?? 0) - (right.location?.startLine ?? 0),
        ),
    ).toEqual([
      {
        rule: "direct-eval",
        location: {
          file: "src/all.ts",
          startLine: 5,
          startColumn: 1,
          endLine: 5,
          endColumn: 13,
        },
      },
      {
        rule: "function-constructor",
        location: {
          file: "src/all.ts",
          startLine: 6,
          startColumn: 1,
          endLine: 6,
          endColumn: 21,
        },
      },
      {
        rule: "child-process-string-exec",
        location: {
          file: "src/all.ts",
          startLine: 7,
          startColumn: 1,
          endLine: 7,
          endColumn: 14,
        },
      },
      {
        rule: "dynamic-vm-execution",
        location: {
          file: "src/all.ts",
          startLine: 8,
          startColumn: 1,
          endLine: 8,
          endColumn: 27,
        },
      },
      {
        rule: "tls-verification-disabled",
        location: {
          file: "src/all.ts",
          startLine: 9,
          startColumn: 4,
          endLine: 9,
          endColumn: 29,
        },
      },
      {
        rule: "weak-password-hash",
        location: {
          file: "src/all.ts",
          startLine: 10,
          startColumn: 1,
          endLine: 10,
          endColumn: 35,
        },
      },
      {
        rule: "credential-over-insecure-http",
        location: {
          file: "src/all.ts",
          startLine: 11,
          startColumn: 9,
          endLine: 11,
          endColumn: 54,
        },
      },
    ]);
  });

  it("shares one root traversal across all checks", () => {
    const roots = vi.spyOn(SgRoot.prototype, "root");
    try {
      expect(
        collectStructuralSecurityObservations("src/safe.ts", "consume(value);"),
      ).toEqual([]);
      expect(roots).toHaveBeenCalledTimes(1);
    } finally {
      roots.mockRestore();
    }
  });

  it("rechecks nodes and bindings each time a public rule receives a root", () => {
    const rule = structuralRules.find(
      (candidate) => candidate.id === "direct-eval",
    )!;
    let current = parse(Lang.TypeScript, "eval(source);");
    const root: SgRoot = {
      root: () => current.root(),
      filename: () => "anonymous",
    };

    expect(rule.matches(root).map((node) => node.text())).toEqual([
      "eval(source)",
    ]);
    current = parse(Lang.TypeScript, "function run(eval) { eval(source); }");
    expect(rule.matches(root)).toEqual([]);
    current = parse(Lang.TypeScript, "eval(other);");
    expect(rule.matches(root).map((node) => node.text())).toEqual([
      "eval(other)",
    ]);
  });

  it.each([
    "function run(http) {}",
    "function run({ client: http }) {}",
    "const run = http => http;",
    "const { client: http } = service;",
    "function http() {}",
    "const run = function http() {};",
    "function* http() {}",
    "const run = function* http() {};",
    "class http {}",
    "const run = class http {};",
    "try {} catch (http) {}",
  ])("preserves file-wide request shadowing for %s", (binding) => {
    const source = [
      'import * as http from "node:http";',
      binding,
      'http.request("http://service.test", { token: secret });',
      'http.request("http://service.test", { token: other });',
    ].join("\n");

    expect(
      collectStructuralSecurityObservations("src/shadowed.js", source),
    ).toEqual([]);
  });

  it.each([
    {
      rule: "direct-eval",
      unsafe: "export const value = eval(userInput);\n",
      safe: "export const value = parser.eval(userInput);\n",
    },
    {
      rule: "function-constructor",
      unsafe: 'export const build = new Function("value", source);\n',
      safe: "export const build = factory.Function(source);\n",
    },
    {
      rule: "child-process-string-exec",
      unsafe:
        'import * as childProcess from "node:child_process";\nchildProcess.exec(command);\n',
      safe: 'import * as childProcess from "node:child_process";\nchildProcess.execFile(binary, args);\n',
    },
    {
      rule: "dynamic-vm-execution",
      unsafe:
        'import vm from "node:vm";\nvm.runInNewContext(source, sandbox);\n',
      safe: "export const value = JSON.parse(source);\n",
    },
    {
      rule: "tls-verification-disabled",
      unsafe:
        'https.request({ hostname: "service.test", rejectUnauthorized: false });\n',
      safe: 'https.request({ hostname: "service.test", rejectUnauthorized: true });\n',
    },
    {
      rule: "weak-password-hash",
      unsafe:
        'import { createHash } from "node:crypto";\ncreateHash("sha1").update(password).digest("hex");\n',
      safe: 'import { createHash } from "node:crypto";\ncreateHash("sha256").update(password).digest("hex");\n',
    },
    {
      rule: "credential-over-insecure-http",
      unsafe:
        'import request from "request";\nrequest({ url: "http://api.example.test/account", headers: { authorization: token } });\n',
      safe: 'import request from "request";\nrequest({ url: "https://api.example.test/account", headers: { authorization: token } });\n',
    },
  ])(
    "reports $rule but ignores its safe near miss",
    ({ rule, unsafe, safe }) => {
      expect(
        collectStructuralSecurityObservations("src/unsafe.ts", unsafe),
      ).toContainEqual(
        expect.objectContaining({
          check: "structuralSecurity",
          rule,
          severity: "error",
          location: expect.objectContaining({
            file: "src/unsafe.ts",
            startLine: expect.any(Number),
            startColumn: expect.any(Number),
            endLine: expect.any(Number),
            endColumn: expect.any(Number),
          }),
          remediation: expect.any(String),
        }),
      );
      expect(
        collectStructuralSecurityObservations("src/safe.ts", safe),
      ).toEqual([]);
    },
  );

  it.each([
    "function run(eval) { return eval(source); }\n",
    "const Function = factory; new Function(source);\n",
    'import { exec } from "node:child_process"; function run(exec) { exec(command); }\n',
    'import vm from "node:vm"; function run(vm) { vm.runInNewContext(source); }\n',
    "const run = eval => eval(source);\n",
    'import { exec } from "node:child_process"; const run = exec => exec(command);\n',
    'import vm from "node:vm"; const run = vm => vm.runInNewContext(source);\n',
    'import { createHash } from "node:crypto"; function run(createHash) { return createHash("md5").update(password); }\n',
  ])("ignores a shadowed dangerous-looking binding", (source) => {
    expect(
      collectStructuralSecurityObservations("src/shadowed.ts", source),
    ).toEqual([]);
  });

  it.each([
    'service.request({ url: "http://api.example.test", token });\n',
    'import request from "request"; request({ url: "http://api.example.test", token: undefined });\n',
    'import request from "request"; request({ url: "http://api.example.test", authorization: null });\n',
  ])("ignores a non-network or credential-free request shape", (source) => {
    expect(
      collectStructuralSecurityObservations("src/request.ts", source),
    ).toEqual([]);
  });

  it.each([
    'import * as http from "node:http"; http.request("http://api.example.test", { headers: { authorization: token } });\n',
    'import request from "request"; request("http://api.example.test", { headers: { authorization: token } });\n',
  ])(
    "finds credentials when the static HTTP URL is a separate argument",
    (source) => {
      expect(
        collectStructuralSecurityObservations("src/request.ts", source),
      ).toContainEqual(
        expect.objectContaining({ rule: "credential-over-insecure-http" }),
      );
    },
  );

  it.each(["js", "jsx", "mjs", "cjs", "ts", "tsx", "mts", "cts"])(
    "parses managed .%s source",
    (extension) => {
      const observations = collectStructuralSecurityObservations(
        `src/unsafe.${extension}`,
        "export const value = eval(source);\n",
      );

      expect(observations).toContainEqual(
        expect.objectContaining({
          rule: "direct-eval",
          location: expect.objectContaining({
            file: `src/unsafe.${extension}`,
          }),
        }),
      );
    },
  );

  it("reports UTF-16 source columns rather than native parser byte columns", () => {
    const observations = collectStructuralSecurityObservations(
      "src/unicode.ts",
      'const label = "🐝"; eval(source);\n',
    );

    expect(observations[0]?.location).toMatchObject({
      startLine: 1,
      startColumn: 21,
    });
  });

  it("accepts a valid empty source file", () => {
    expect(collectStructuralSecurityObservations("src/empty.ts", "")).toEqual(
      [],
    );
  });

  it.each(["jsx", "tsx"])(
    "accepts literal ampersands in valid .%s JSX text",
    (extension) => {
      expect(
        collectStructuralSecurityObservations(
          `src/view.${extension}`,
          "const App = () => <p>Works & more</p>;",
        ),
      ).toEqual([]);
    },
  );

  it("checks JSX expressions after literal ampersands at original source coordinates", () => {
    const source = [
      "const App = () => <p>",
      "  🐝 & {eval(source)}",
      "</p>;",
    ].join("\n");

    expect(
      collectStructuralSecurityObservations("src/view.tsx", source),
    ).toEqual([
      expect.objectContaining({
        rule: "direct-eval",
        identity: "direct-eval:src/view.tsx:2:9:2:21",
        location: {
          file: "src/view.tsx",
          startLine: 2,
          startColumn: 9,
          endLine: 2,
          endColumn: 21,
        },
      }),
    ]);
  });

  it.each([
    "const App = () => <p>Works & more {eval(}</p>;",
    "const App = () => <p>Works & more</div>;",
    "const App = () => <p>Works & more</p>; const broken = ;",
    "const App = () => <p>{value &}</p>;",
  ])("rejects invalid syntax alongside JSX text: %s", (source) => {
    expect(() =>
      collectStructuralSecurityObservations("src/broken.tsx", source),
    ).toThrow("Structural security analysis failed.");
  });

  it("fails closed when the source cannot be parsed completely", () => {
    for (const source of [
      "export function broken( {\n",
      "function f() {",
      "const value = { key: }",
    ]) {
      expect(() =>
        collectStructuralSecurityObservations("src/broken.ts", source),
      ).toThrow("Structural security analysis failed.");
    }
  });
});
