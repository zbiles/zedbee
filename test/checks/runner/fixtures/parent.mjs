import { runAnalyzerJob } from "../../../../src/checks/runner/run-job.ts";
import { DEFAULT_FORMATTING_SETTINGS } from "../../../../src/checks/prettier/settings.ts";
const [workerEntry, path] = process.argv.slice(2);
await runAnalyzerJob(
  {
    version: 1,
    checkId: "formatting",
    operation: "format-working-source",
    input: {
      file: "a.js",
      settings: DEFAULT_FORMATTING_SETTINGS,
      source: JSON.stringify({ mode: "blocked", path }),
    },
  },
  { workerEntry },
);
