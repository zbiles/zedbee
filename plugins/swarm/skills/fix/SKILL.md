---
name: fix
description: Apply Zedbee Swarm's built-in formatting, lint, and React correctness autofixes. Report remaining findings without writing agent-authored repairs.
---

# Swarm built-in autofixes

Use only the installed Zedbee CLI's managed fixes. This command does not authorize
agent-authored source repairs. Offer `/swarm --agent-fix` for findings requiring
agent edits, but wait for that authorization before performing them.

Read repository instructions, Git status, staged and unstaged diffs, and
[the complete scan workflow](../../references/scan.md) for snapshot, process
status, conflict, trust, and verification rules. Its manual repair instructions
apply only to the separate agent-assisted mode, not this skill.

If the CLI is missing, offer [installation/setup](../../references/setup.md) and
wait unless already authorized. If no staged proposal exists, explain that
managed fixes analyze staged code. Never stage files just to produce a fix plan.
An undeclared node_modules copy left after a failed install needs the same setup
offer and verification; do not execute it as an existing installation.
Managed `fix` does not support `--base`; never substitute index findings for a
committed branch report.

Preview the combined managed fix plan so the CLI can compose exact edits before
formatting in its supported order:

```sh
zedbee fix --format json
```

For a narrower request or scope, use `fix formatting`, `fix lint`, or
`fix reactCorrectness` instead; only those three selectors are supported.
Lint and React correctness apply exact
reported official fixes, not suggestions. Formatting rewrites the complete current
working file, including unstaged work; inspect that scope before applying. Do not
enable project-Prettier trust without an explicit trust decision.

The request to apply built-in fixes authorizes ordinary applicable managed edits;
do not ask again for the same scope. Use `zedbee fix --yes --format json` (or the
reviewed named selector) when applying, and inspect its current plan and complete
result. Skip overlapping,
stale, or unauthorized work. A nonzero result may still have changed files; review
partial progress before retrying. Do not apply suggestions, edit code manually,
disable checks, or broaden the requested scope to clear remaining findings.

Summarize which built-in fixes applied, skipped or failed, and what remains.
Review the working-tree diff and preserve unrelated work. Never stage or commit
automatically. Rescan only when repaired bytes enter the authorized target; if
the index is unchanged, say that staged verification is still pending. Do not
equate successful application with a passing source scan.
