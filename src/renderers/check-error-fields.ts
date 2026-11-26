import type { CheckError } from "../core/types.js";

export function checkErrorDetailFields(
  error: CheckError,
): Record<string, unknown> {
  return {
    ...(error.path === undefined ? {} : { path: error.path }),
    ...(error.parseFailures === undefined
      ? {}
      : { parseFailures: error.parseFailures }),
    ...(error.paths === undefined ? {} : { paths: [...error.paths] }),
    ...(error.snapshot === undefined ? {} : { snapshot: error.snapshot }),
    ...(error.projectPaths === undefined
      ? {}
      : { projectPaths: [...error.projectPaths] }),
    ...(error.temporaryPath === undefined
      ? {}
      : { temporaryPath: error.temporaryPath }),
    ...(error.remediation === undefined
      ? {}
      : { remediation: error.remediation }),
  };
}
