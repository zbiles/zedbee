# Task 1 Report: Resolve a safe committed comparison

## What was implemented

Implemented `resolveBaseComparison` and its public result/error types. The resolver validates caller-supplied base text before invoking Git, resolves the requested base tip and `HEAD` with literal revision arguments, computes merge bases with `merge-base --all`, validates lowercase 40- or 64-character object IDs, classifies expected failures with stable error codes, sanitizes error messages, and preserves abort/resource exceptions.

## Files changed

- `src/git/base-comparison.ts`
- `test/git/base-comparison.test.ts`

## Self-review

- Git arguments match the required arrays, including `--end-of-options` for the caller-controlled ref.
- Caller validation rejects empty, option-looking, NUL-containing, and display-control-containing refs before Git runs.
- Only one final newline is removed from individual revision output; merge-base output is split into nonempty lines and each ID is validated before ambiguity is reported.
- Raw requested refs, stdout, and stderr are absent from resolver error messages.
- Abort exceptions are not caught or rewritten.
- `git diff --check` passed for both task files.

## Concerns

The full suite has two pre-existing/network-dependent package-manager fixture failures: pnpm returned an output without `exitCode`, and yarn could not resolve the package versions from the npm registry. The focused tests and typecheck pass.

## Verification

Focused command:

```text
npx vitest run test/git/base-comparison.test.ts test/git/client.test.ts
```

Result: 2 test files passed, 22 tests passed.

Typecheck:

```text
npm run typecheck
```

Result: passed.

Full suite:

```text
npm test
```

Result: build passed; 139 test files passed, 1 failed; 1,751 tests passed, 1 skipped, 2 failed. Both failures were in `test/e2e/package-managers.test.ts` and depended on package-manager/network fixture installation.

## TDD evidence

RED command:

```text
npx vitest run test/git/base-comparison.test.ts
```

Output/reason: the suite failed during module loading with `Cannot find module '../../src/git/base-comparison.js'`; this was the expected failure because the production module did not yet exist.

GREEN command:

```text
npx vitest run test/git/base-comparison.test.ts test/git/client.test.ts && npm run typecheck
```

Output/result: 2 test files passed and 22 tests passed; TypeScript typecheck completed successfully.
