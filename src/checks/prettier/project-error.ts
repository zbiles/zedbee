import type { ProjectPrettierFailure } from "./project-types.js";

export class ProjectPrettierFailureError extends Error {
  readonly code: ProjectPrettierFailure["code"];
  readonly failure: ProjectPrettierFailure;

  constructor(failure: ProjectPrettierFailure) {
    super(failure.message);
    this.name = "ProjectPrettierFailureError";
    this.code = failure.code;
    this.failure = failure;
    Object.freeze(this);
  }
}
