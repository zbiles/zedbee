---
name: fix
description: Repair authorized Zedbee Swarm findings and verify the updated proposal while preserving unrelated staged and unstaged work.
---

# Repair and verify Swarm findings

Read [the complete scan, repair, and verification workflow](../scan/SKILL.md)
before acting, and follow its snapshot, authorization and partial-progress rules.
Use the complete current report, not a truncated terminal preview or a stale plan.
If no usable CLI is installed, follow [setup](../setup/SKILL.md) within existing
authorization.

Focus on the requested repairs. Preview only the applicable managed fix selectors;
apply them when their scope is authorized. Formatting changes an entire current
working file, including unstaged work. Confirm manual repairs against the intended
behavior, inspect every partial failure, run relevant project tests, and rescan
only after the repaired bytes enter the authorized target. Disclose incomplete or
unverified analysis and decisions that remain outstanding.
