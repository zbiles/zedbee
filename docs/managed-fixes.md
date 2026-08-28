# Managed fixes

`zedbee fix` rescans the current staged code, builds a fresh source-free plan,
and applies only approved managed fixes to working files. It never stages or
commits. Review the resulting working-tree diff, stage the changes you want,
and rescan before committing.

## Quick start

Preview every supported kind of fix:

```bash
npx zedbee fix
```

In an interactive terminal, the preview is followed by a confirmation. A narrow
TTY remains a framed interactive, scrollable UI where you can Apply or Cancel;
width changes the viewport, not the approval behavior. A non-TTY invocation
without `--yes` prints a linear preview and does not write. `--yes` is the
automation approval flag:

```bash
npx zedbee fix --yes
npx zedbee fix --yes --format json
```

The bare command selects all three fixable checks. A named selector limits the
fresh analysis and plan to only the selected check:

```bash
npx zedbee fix formatting
npx zedbee fix lint
npx zedbee fix reactCorrectness
```

`formatting`, `lint`, and `reactCorrectness` are the only supported selectors.
For example, `zedbee fix reactAccessibility` is rejected instead of silently
doing something else. Suggestions and all unsupported checks remain manual.

## What Zedbee can change

Both blocking and warning fixes are included when their check and rule are
enabled. Severity affects scan policy, not whether a safe supported fix may be
offered.

| Check              | Managed behavior                                                                                                   | Working-tree scope                                                 |
| ------------------ | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `lint`             | Applies only exact reported official fixes from Zedbee's bundled ESLint rules; ESLint suggestions remain manual    | Exact finding ranges, composed with non-overlapping unstaged edits |
| `reactCorrectness` | Applies only exact reported official fixes from the bundled React and Hooks rules; React suggestions remain manual | Exact finding ranges, composed with non-overlapping unstaged edits |
| `formatting`       | Runs managed Prettier after exact fixes                                                                            | Complete current working file, including unstaged work             |

ESLint and React correctness therefore apply only exact reported official fixes.
They do not run a broad `--fix`, apply suggestions, repair unreported debt, or
load project plugins and configuration. Prettier intentionally has whole-file
semantics: it formats the complete current working file, including unstaged
work in that file. Select `lint` or `reactCorrectness` alone when whole-file
formatting is not wanted.

For a file that receives both kinds, exact fixes run before selected
formatting. This preserves one deterministic order:

```text
current working bytes
  -> compose non-overlapping exact lint/React edits
  -> format the complete resulting working file
  -> atomically replace that working file
```

## Staged and unstaged examples

Suppose `src/value.ts` contains a staged extra semicolon, followed by a new
unstaged declaration. Bare `zedbee fix` can remove the exact staged lint error
and then format both declarations because formatting sees the complete current
working file. The Git index remains byte-for-byte unchanged.

If an unstaged edit overlaps the exact range Zedbee planned to replace, that
file is skipped as a conflict. Non-overlapping unstaged edits are preserved and
can receive selected whole-file formatting. Zedbee also skips a file if it
changes after the preview, if its exact fixes conflict, or if safe read,
formatting, or atomic write checks fail.

The plan describes `target: "index"` because findings come from the fresh staged
snapshot. Application still targets working files only. Zedbee never stages or
commits, so the staged proposal is not silently rewritten under a pending
commit.

## Preview and JSON

A typical compact plan reports selected checks, fix and file counts, blocking
and warning counts, file paths, whether each file already has unstaged changes,
and finding IDs:

```json
{
  "applied": false,
  "schemaVersion": 1,
  "target": "index",
  "selectedChecks": ["formatting", "lint", "reactCorrectness"],
  "exitCode": 0,
  "summary": {
    "fixes": 2,
    "files": 1,
    "blocking": 1,
    "warnings": 1,
    "skipped": 0
  },
  "files": [{ "path": "src/value.ts", "fixes": 2, "hasUnstagedChanges": true }],
  "items": [
    {
      "checkId": "lint",
      "file": "src/value.ts",
      "findingIds": ["example-id"],
      "scope": "finding",
      "blocking": 1,
      "warnings": 0
    },
    {
      "checkId": "formatting",
      "file": "src/value.ts",
      "findingIds": ["example-format-id"],
      "scope": "working-file",
      "blocking": 0,
      "warnings": 1
    }
  ]
}
```

JSON remains schema version 1 and contains no replayable patch. Plans and apply
results are source-free metadata: they omit source text, replacements, base
content, hashes, absolute repository paths, and private execution material.
`--format json` without `--yes` is a deterministic, non-writing automation
preview with `applied: false`; adding `--yes` returns `applied: true` and a
source-free `result`.

Large interactive or text plans can persist the same complete source-free JSON
metadata in protected operating-system temporary storage. Maintenance warnings
do not change the fix outcome. The path is printed only after the report exists;
use explicit JSON redirection when an automation needs durable output.

## Partial progress, conflicts, and durability

Partial completion applies safe files, reports skipped fixes with the file,
issue kind, reason, and remediation, and exits 1. A conflict or stale file does
not roll back a different safe file. Files are validated and replaced
independently.
Inspect every reported issue before retrying.

A durability warning can mean the working file was replaced but Zedbee could
not confirm directory durability. That is partial progress with a nonzero exit;
do not retry automatically. Inspect the file and filesystem first. An
untrustworthy or incomplete fresh plan is never applied and exits 2.

| Status | Managed-fix meaning                                                                                                                             |
| -----: | ----------------------------------------------------------------------------------------------------------------------------------------------- |
|    `0` | Preview/cancellation made no writes, or every approved file operation completed without an issue                                                |
|    `1` | Some safe work may have completed, but at least one conflict, stale file, formatting failure, write failure, or durability warning was reported |
|    `2` | Zedbee could not build a trustworthy complete plan; no plan was applied                                                                         |

## Review, stage, and rescan

After an apply, treat the working tree as developer-owned work:

```bash
git diff -- src/value.ts
git diff --cached
git add -- src/value.ts
npx zedbee scan
```

Review the full working-tree diff, stage only the intended result, and rescan
the newly current index. Re-running `zedbee fix` also rescans current staged
code and recalculates candidates; it does not replay a prior plan. If a conflict
was reported, resolve the overlap manually before building another plan.

For agents and CI, prefer `npx zedbee fix --format json` to inspect a plan and
`npx zedbee fix --yes --format json` only after policy grants write approval.
Check `applied`, the top-level plan `exitCode`, the applied `result.exitCode`,
every issue, and the process status. Never infer that files were staged, never
commit automatically, and always review, stage, and rescan explicitly.
