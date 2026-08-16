import { describe, expect, it } from "vitest";
import { collectStructuralSecurityObservations } from "../../../src/checks/structural-security/rules.js";

describe("collectStructuralSecurityObservations", () => {
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
