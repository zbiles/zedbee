import { writeSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { relative, resolve, sep } from "node:path";
import { PROJECT_ESLINT_MAX_BYTES } from "./protocol.js";
import type {
  ProjectEslintDiagnostic,
  ProjectEslintFailureCode,
  ProjectEslintRequest,
} from "./types.js";

function send(value: unknown): void {
  const serialized = JSON.stringify(value);
  const payload =
    Buffer.byteLength(serialized) <= PROJECT_ESLINT_MAX_BYTES
      ? serialized
      : JSON.stringify({ ok: false, code: "PROJECT_ESLINT_OUTPUT_LIMIT" });
  writeSync(4, payload + "\n");
}
process.on("disconnect", () => process.exit(0));
process.once("message", (raw: ProjectEslintRequest) => {
  void (async () => {
    let failureCode: ProjectEslintFailureCode = "PROJECT_ESLINT_CONFIG_INVALID";
    try {
      if (raw.type !== "run") throw new Error("Invalid request");
      const require = createRequire(import.meta.url);
      const { ESLint } = require(
        raw.installation.entry,
      ) as typeof import("eslint");
      if (ESLint.version !== "9.39.5") {
        failureCode = "PROJECT_ESLINT_VERSION_UNSUPPORTED";
        throw new Error("Wrong version");
      }
      const cwd = resolve(raw.treeRoot, raw.projectRoot);
      const eslint = new ESLint({ cwd });
      if ((await eslint.findConfigFile()) !== raw.configFile) {
        failureCode = "PROJECT_ESLINT_CONFIG_UNSUPPORTED";
        throw new Error("Unexpected config");
      }
      const checkedFiles: string[] = [],
        ignoredFiles: string[] = [];
      for (const file of raw.files) {
        const absolute = resolve(raw.treeRoot, file);
        if (await eslint.isPathIgnored(absolute)) {
          ignoredFiles.push(file);
          continue;
        }
        const config = (await eslint.calculateConfigForFile(absolute)) as
          { processor?: unknown } | undefined;
        if (config?.processor !== undefined) {
          failureCode = "PROJECT_ESLINT_CONFIG_UNSUPPORTED";
          throw new Error("Processor unsupported");
        }
        if (config === undefined) {
          ignoredFiles.push(file);
          continue;
        }
        checkedFiles.push(file);
      }
      const diagnostics: ProjectEslintDiagnostic[] = [];
      if (checkedFiles.length) {
        const results = await eslint.lintFiles(
          checkedFiles.map((file) => resolve(raw.treeRoot, file)),
        );
        for (const result of results)
          for (const message of result.messages) {
            if (message.fatal) throw new Error("Incomplete parsing");
            const file = relative(raw.treeRoot, result.filePath)
              .split(sep)
              .join("/");
            // Raw source-bearing diagnostics never cross the worker boundary in redacted mode.
            diagnostics.push({
              file,
              ruleId: message.ruleId,
              severity: message.severity as 1 | 2,
              comparisonIdentity: createHash("sha256")
                .update(`${message.severity}\0${message.message}`)
                .digest("hex"),
              message: raw.fullMessages
                ? message.message.replace(/[\x00-\x1f\x7f-\x9f]/gu, " ")
                : "The project's ESLint reported a diagnostic.",
              ...(message.line ? { line: message.line } : {}),
              ...(message.column ? { column: message.column } : {}),
              ...(message.endLine ? { endLine: message.endLine } : {}),
              ...(message.endColumn ? { endColumn: message.endColumn } : {}),
              ...(message.fatal ? { fatal: true } : {}),
            });
          }
      }
      send({
        ok: true,
        result: { version: "9.39.5", diagnostics, checkedFiles, ignoredFiles },
      });
    } catch {
      send({ ok: false, code: failureCode });
    }
  })();
});
