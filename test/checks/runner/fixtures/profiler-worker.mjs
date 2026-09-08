import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import "../../../../src/checks/runner/worker.ts";

const require = createRequire(import.meta.resolve("@secretlint/core"));
const { secretLintProfiler } = await import(
  pathToFileURL(require.resolve("@secretlint/profiler")).href
);
let output;
process.on("message", (message) => {
  if (message?.type === "job")
    output = join(
      message.request.context.repositoryRoot,
      "profiler-state.json",
    );
});
const send = process.send.bind(process);
process.send = (message, ...args) => {
  if (message?.type !== "released") return send(message, ...args);
  Promise.all([
    secretLintProfiler.getEntries(),
    secretLintProfiler.getMeasures(),
  ]).then(([entries, measures]) => {
    writeFileSync(
      output,
      JSON.stringify({
        enabled: secretLintProfiler.isEnabled,
        entries,
        measures,
      }),
    );
    output = undefined;
    send(message, ...args);
  });
  return true;
};
