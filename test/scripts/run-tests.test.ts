import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execa } from "execa";
import ts from "typescript";
import { waitForAssertion } from "../helpers/wait-for-assertion.js";
import { superviseRun } from "../../scripts/run-with-deadline.mjs";
import vitestConfig from "../../vitest.config.js";

const testRoot = resolve(import.meta.dirname, "..");
const hookApis = new Set([
  "afterAll",
  "afterEach",
  "aroundAll",
  "aroundEach",
  "beforeAll",
  "beforeEach",
]);
const testApis = new Set(["describe", "it", "suite", "test"]);
const timeoutApis = new Set([...hookApis, ...testApis]);

function vitestApi(
  expression: ts.Expression,
  bindings: ReadonlyMap<string, string>,
): string | undefined {
  if (ts.isIdentifier(expression))
    return bindings.get(expression.text);
  if (ts.isCallExpression(expression))
    return vitestApi(expression.expression, bindings);
  if (ts.isPropertyAccessExpression(expression))
    return vitestApi(expression.expression, bindings);
  return undefined;
}

function propertyName(property: ts.ObjectLiteralElementLike): string | undefined {
  if (!property.name) return undefined;
  if (ts.isComputedPropertyName(property.name))
    return ts.isStringLiteral(property.name.expression)
      ? property.name.expression.text
      : undefined;
  return property.name.getText().replaceAll(/["']/gu, "");
}

function timeoutOverrides(path: string, contents: string): string[] {
  const source = ts.createSourceFile(
    path,
    contents,
    ts.ScriptTarget.Latest,
    true,
  );
  const bindings = new Map<string, string>();
  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== "vitest" ||
      !statement.importClause?.namedBindings ||
      !ts.isNamedImports(statement.importClause.namedBindings)
    )
      continue;
    for (const binding of statement.importClause.namedBindings.elements) {
      const imported = (binding.propertyName ?? binding.name).text;
      if (timeoutApis.has(imported)) bindings.set(binding.name.text, imported);
    }
  }
  const overrides: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const api = vitestApi(node.expression, bindings);
      const option =
        api === undefined
          ? undefined
          : node.arguments.slice(1).find(
              (argument) =>
                ts.isObjectLiteralExpression(argument) &&
                argument.properties.some(
                  (property) => propertyName(property) === "timeout",
                ),
            );
      const positional =
        api !== undefined && hookApis.has(api)
          ? node.arguments[1]
          : api !== undefined &&
              testApis.has(api) &&
              node.arguments[2] &&
              !ts.isObjectLiteralExpression(node.arguments[1]!)
            ? node.arguments[2]
            : undefined;
      const timeout = option ?? positional;
      if (timeout) {
        const { line } = source.getLineAndCharacterOfPosition(
          timeout.getStart(source),
        );
        overrides.push(`${path}:${line + 1}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return overrides;
}

describe("test-run deadline", () => {
  it("leaves test and hook deadlines to the run supervisor", () => {
    expect(vitestConfig).toMatchObject({
      test: { testTimeout: 0, hookTimeout: 0 },
    });
  });

  it("contains no test or hook timeout overrides", async () => {
    const files = (await readdir(testRoot, { recursive: true })).filter(
      (path) => path.endsWith(".test.ts") || path.endsWith(".test.tsx"),
    );
    const overrides: string[] = [];
    for (const path of files) {
      overrides.push(
        ...timeoutOverrides(
          path,
          await readFile(join(testRoot, path), "utf8"),
        ),
      );
    }
    expect(overrides).toEqual([]);
  });

  it.each([
    [
      "a test timeout identifier",
      'import { it } from "vitest"; const TEST_TIMEOUT = 1000; it("case", () => {}, TEST_TIMEOUT);',
      ["fixture.test.ts:1"],
    ],
    [
      "a hook timeout identifier",
      'import { beforeAll } from "vitest"; const timeoutMs = 1000; beforeAll(() => {}, timeoutMs);',
      ["fixture.test.ts:1"],
    ],
    [
      "an identifier-valued timeout option",
      'import { it } from "vitest"; const TEST_TIMEOUT = 1000; it("case", { timeout: TEST_TIMEOUT }, () => {});',
      ["fixture.test.ts:1"],
    ],
    [
      "an aliased Vitest timeout",
      'import { it as spec } from "vitest"; const TEST_TIMEOUT = 1000; spec("case", () => {}, TEST_TIMEOUT);',
      ["fixture.test.ts:1"],
    ],
    [
      "a test without a timeout",
      'import { it } from "vitest"; it("case", () => {});',
      [],
    ],
    [
      "non-timeout test options",
      'import { it } from "vitest"; it("case", { retry: 1 }, () => {});',
      [],
    ],
    [
      "an unrelated same-name function",
      'const TEST_TIMEOUT = 1000; function it(...values: unknown[]) { return values; } it("case", () => {}, TEST_TIMEOUT);',
      [],
    ],
  ] as const)("classifies %s", (_name, contents, expected) => {
    expect(timeoutOverrides("fixture.test.ts", contents)).toEqual(expected);
  });

  it("terminates descendants even when they ignore graceful shutdown", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zedbee-supervisor-"));
    const pidFile = join(directory, "descendant.pid");
    const controller = new AbortController();
    let pid: number | undefined;
    const leaf = `
      process.on("SIGTERM", () => {});
      require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
      setInterval(() => {}, 1000);
    `;
    const branch = `
      require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(leaf)}], { stdio: "ignore" });
      setInterval(() => {}, 1000);
    `;
    const pending = superviseRun(["-e", branch], {
      stdio: "pipe",
      cancelSignal: controller.signal,
    });
    try {
      // Synchronize on readiness, not a guessed process-startup duration.
      pid = await waitForAssertion(async () => {
        const value = Number(await readFile(pidFile, "utf8"));
        expect(Number.isSafeInteger(value) && value > 0).toBe(true);
        return value;
      });
      controller.abort();
      expect((await pending).exitCode).not.toBe(0);
      if (process.platform === "win32") {
        expect(() => process.kill(pid!, 0)).toThrow();
      } else {
        const status = await execa("ps", ["-p", String(pid), "-o", "stat="], {
          reject: false,
        });
        expect(status.stderr).toBe("");
        // A zombie has terminated but is waiting for its OS parent to reap it.
        expect(
          status.exitCode !== 0 || status.stdout.trim().startsWith("Z"),
        ).toBe(true);
      }
    } finally {
      controller.abort();
      await pending;
      if (pid !== undefined) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* Already gone. */
        }
      }
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("preserves a test process failure", async () => {
    const result = await superviseRun(["-e", "process.exit(7)"], {
      env: { ...process.env, GITHUB_ACTIONS: "false" },
      stdio: "pipe",
    });
    expect(result.exitCode).toBe(7);
    expect(result.timedOut).toBe(false);
  });

  it("stops a stuck local run at the overall deadline", async () => {
    const result = await superviseRun(["-e", "setInterval(() => {}, 1000)"], {
      env: { ...process.env, GITHUB_ACTIONS: "false" },
      timeoutMs: 100,
      stdio: "pipe",
    });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(124);
  });

  it("leaves the overall deadline to GitHub inside an Actions job", async () => {
    const result = await superviseRun(
      ["-e", "setTimeout(() => process.exit(0), 100)"],
      {
        env: { ...process.env, GITHUB_ACTIONS: "true" },
        timeoutMs: 1,
        stdio: "pipe",
      },
    );
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
  });
});
