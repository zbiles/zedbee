import { applyEdits, modify, parse } from "jsonc-parser";
import { configFileSchema } from "../config/schema.js";
import { resolveConfig } from "../config/profiles.js";
import {
  assertProjectEslintConfiguration,
  resolveWorkspaceLintPolicy,
} from "../config/target-policy.js";
import type { RepositoryInspection } from "../inspection/types.js";
import type { CreateInitProposalOptions } from "./types.js";

export class ProjectEslintSetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectEslintSetupError";
  }
}

export const PROJECT_ESLINT_DISCLOSURE =
  "Project ESLint is experimental. It replaces managed lint, React, and static JSX accessibility checks with the project's rules. Coverage can be broader or narrower, and any repository change can require a full source scan.";
export const PROJECT_ESLINT_EXECUTION_DISCLOSURE =
  "The project's ESLint configuration and plugins execute code. Trust covers this repository's selected workspaces across branches and worktrees, including future edits and versions.";
export const PROJECT_ESLINT_MESSAGES_DISCLOSURE =
  "Full local diagnostic messages can quote source code and other private data, including in JSON reports. Declining keeps working analysis with redacted messages.";

export function configureInitEslint(
  source: string,
  before: string | null,
  inspection: RepositoryInspection,
  options: Pick<
    CreateInitProposalOptions,
    "eslintEngine" | "projectEslintMessages"
  >,
) {
  const editOptions = {
    formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
  };
  let after = source;
  const set = (path: (string | number)[], value: unknown) => {
    after = applyEdits(after, modify(after, path, value, editOptions));
  };
  const prior = before === null ? {} : parse(before);
  const inheritedProject =
    prior?.checks?.lint?.engine === "project" ||
    (prior?.overrides ?? []).some(
      (entry: { checks?: { lint?: { engine?: string } } }) =>
        entry.checks?.lint?.engine === "project",
    );
  if (
    options.eslintEngine === "project" ||
    (options.eslintEngine === undefined && inheritedProject)
  ) {
    // Repeated setup must not erase existing explicit managed intent to make
    // a project selection appear valid. Conflicts stay visible in the diff.
    const existing = before === null ? {} : (parse(before)?.checks ?? {});
    for (const id of ["lint", "reactCorrectness", "reactAccessibility"]) {
      if (existing[id] !== undefined) {
        const generated = parse(after)?.checks?.[id];
        const lintDisabled =
          id === "lint" &&
          (generated === "off" || generated?.severity === "off");
        set(
          ["checks", id],
          lintDisabled
            ? {
                ...(typeof existing[id] === "string"
                  ? { severity: existing[id] }
                  : existing[id]),
                severity: "off",
              }
            : existing[id],
        );
      } else if (id !== "lint" && parse(after)?.checks?.[id] !== undefined)
        set(["checks", id], undefined);
    }
  }
  if (options.eslintEngine !== undefined) {
    const lint = parse(after)?.checks?.lint;
    set(["checks", "lint"], {
      ...(typeof lint === "string" ? { severity: lint } : (lint ?? {})),
      engine: options.eslintEngine,
    });
    // Selecting managed globally also withdraws explicit workspace project
    // selections while preserving every scope's other policy and comments.
    if (options.eslintEngine === "managed") {
      const overrides = parse(after)?.overrides ?? [];
      for (const [index, override] of overrides.entries()) {
        if (override.checks?.lint?.engine !== undefined)
          set(["overrides", index, "checks", "lint", "engine"], "managed");
      }
    }
  }
  if (options.projectEslintMessages !== undefined)
    set(["reporting", "projectEslintMessages"], options.projectEslintMessages);
  let engine: "managed" | "project" = options.eslintEngine ?? "managed";
  let messages: "redacted" | "full" =
    options.projectEslintMessages ?? "redacted";
  let roots: readonly string[] = [];
  const conflicts: string[] = [];
  try {
    const resolved = resolveConfig(configFileSchema.parse(parse(after)));
    engine = resolved.checks.lint.engine;
    messages = resolved.reporting.projectEslintMessages;
    roots = inspection.workspaces
      .filter(
        (workspace) =>
          resolveWorkspaceLintPolicy(resolved, workspace).engine === "project",
      )
      .map(({ relativeRoot }) => relativeRoot);
    if (roots.length > 0) engine = "project";
    assertProjectEslintConfiguration(resolved, inspection);
  } catch (error) {
    if (
      options.eslintEngine === "project" ||
      parse(after)?.checks?.lint?.engine === "project"
    ) {
      roots = inspection.workspaces.map(({ relativeRoot }) => relativeRoot);
      conflicts.push(
        error instanceof Error
          ? error.message
          : "Project ESLint settings conflict with managed configuration.",
      );
    }
  }
  return {
    after,
    engine,
    messages,
    roots: Object.freeze([...roots]),
    conflicts: Object.freeze(conflicts),
  };
}
