### Task 6 Report: file-scoped complexity and workspace-wide duplication settings

Status: implemented and verified.

### RED Evidence

Command:

```bash
npm run build && npx vitest run test/checks/complexity/adapter.test.ts test/checks/observation-result.test.ts test/checks/duplication/adapter.test.ts test/config/json-schema.test.ts
```

Result: FAIL after adding the regression tests.

Relevant failure:

```text
test/checks/complexity/adapter.test.ts > collectComplexityObservations > 'cyclomaticComplexity' stores file-scoped metric limits on both snapshot sides
test/checks/complexity/adapter.test.ts > collectComplexityObservations > 'readabilityComplexity' stores file-scoped metric limits on both snapshot sides
AssertionError: expected 1 to be 99
```

This showed complexity collection still applied the workspace policy limit to every metric observation instead of resolving the target file policy for `test/**`, including the renamed baseline path.

Duplication/schema tests added in the same RED cycle were already green against the current branch because prior work had already made duplication settings workspace-wide and injected managed jscpd options. They remain as coverage for the private config seam and override rejection.

### Implementation

Files changed:

- `src/checks/complexity/adapter.ts`
- `test/checks/complexity/adapter.test.ts`
- `test/checks/duplication/adapter.test.ts`
- `test/config/json-schema.test.ts`

Changes:

- Complexity baseline and target collection now calls `context.policyForFile(checkId, file, side)` for each metric observation source file.
- Baseline collection passes `"baseline"`, so renamed baseline paths use the target path policy through the existing rename map.
- Target collection passes `"target"`, so collected metric metadata preserves each target observation's resolved `metric.limit`.
- Complexity formulas, metric values, ordering, identities, and finding evaluation behavior were left unchanged.
- Added adapter-level regression coverage for equal-score functions under `src/**` and `test/**` with different `max` values, including a rename from `src/legacy.ts` to `test/renamed.test.ts`.
- Added duplication managed-config coverage that captures the jscpd config passed to the private subprocess seam and asserts public settings plus fixed private values:
  - `threshold: 7.5`
  - `minLines: 8`
  - `minTokens: 75`
  - `mode: "strict"`
  - fixed `format`, `reporters`, `silent`, and `gitignore`
- Added JSON Schema coverage rejecting duplication `threshold` and `settings` in file overrides.

### GREEN Evidence

Focused suite after implementation and formatting:

```bash
npm run build && npx vitest run test/checks/complexity/adapter.test.ts test/checks/complexity/readability-rule.test.ts test/checks/observation-result.test.ts test/checks/duplication/adapter.test.ts test/checks/duplication/normalize-clone.test.ts test/config/json-schema.test.ts
```

Result:

```text
Test Files  6 passed (6)
Tests       104 passed (104)
```

Typecheck:

```bash
npm run typecheck
```

Result:

```text
tsc -p tsconfig.json --noEmit
```

Exit code: 0.

Schema check:

```bash
npm run schema:check
```

Result:

```text
Configuration schema is current.
```

Prettier:

```bash
npx prettier --check src/checks/complexity/adapter.ts test/checks/complexity/adapter.test.ts test/checks/duplication/adapter.test.ts test/config/json-schema.test.ts
```

Result:

```text
All matched files use Prettier code style!
```

Diff check:

```bash
git diff --check
```

Result: exit code 0, no whitespace errors.

### Self-Review

- Verified production change is limited to complexity collection policy resolution.
- Verified duplication subprocess execution order, abort handling, output validation, normalization, and fixed private jscpd fields are not changed.
- Verified JSON schema was not regenerated because `schema:check` reports the checked-in schema is current.
- Verified no native config, dependency, or version files changed.

### Concerns

- None.
