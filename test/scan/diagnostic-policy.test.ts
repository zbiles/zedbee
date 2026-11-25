import { expect, it } from "vitest";
import { CHECK_IDS } from "../../src/config/schema.js";
import {
  withAnalysisSession,
  DEFAULT_ANALYSIS_SESSION_DEPENDENCIES,
} from "../../src/scan/analysis-session.js";
import { createGitRepository } from "../helpers/git-repository.js";

it("applies an invocation diagnostic policy before analysis without changing tracked config", async () => {
  const repo = await createGitRepository("zedbee-diagnostic-policy-");
  const configText = JSON.stringify({
    schemaVersion: 1,
    checks: Object.fromEntries(CHECK_IDS.map((id) => [id, "off"])),
    reporting: { diagnosticMessages: "source-free", sourceExcerpts: "never" },
  });
  await repo.write(".zedbeerc.jsonc", configText);
  await repo.write("file.ts", "export const value = 1;\n");
  await repo.commitAll("baseline");
  await repo.write("file.ts", "export const value = 2;\n");
  await repo.git(["add", "file.ts"]);
  let observed: unknown;
  const result = await withAnalysisSession(
    {
      repositoryRoot: repo.root,
      diagnosticMessages: "contextual",
      dependencies: DEFAULT_ANALYSIS_SESSION_DEPENDENCIES,
      onConfiguration: (config) => {
        observed = config.reporting;
      },
    },
    async (session) =>
      session.kind === "unsupported" ? undefined : session.config.reporting,
  );
  expect(result.completed).toBe(true);
  expect(observed).toMatchObject({
    diagnosticMessages: "contextual",
    sourceExcerpts: "never",
  });
  if (result.completed)
    expect(result.value).toMatchObject({
      diagnosticMessages: "contextual",
      sourceExcerpts: "never",
    });
  expect(await repo.read(".zedbeerc.jsonc")).toBe(configText);
});
