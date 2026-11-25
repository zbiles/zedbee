import type * as ts from "typescript";

// Implicit discovery can legitimately produce types:[] when nothing is installed.
// Keep that distinct from an explicit exclusion selected by repository policy.
const configuredTypes = new WeakMap<
  ts.CompilerOptions,
  readonly string[] | undefined
>();
export function rememberConfiguredTypes(
  options: ts.CompilerOptions,
  types: readonly string[] | undefined,
): void {
  configuredTypes.set(
    options,
    types === undefined ? undefined : Object.freeze([...types]),
  );
}
export function configuredTypesForProgram(
  program: ts.Program,
): readonly string[] | undefined {
  const options = program.getCompilerOptions();
  return configuredTypes.has(options)
    ? configuredTypes.get(options)
    : options.types;
}
