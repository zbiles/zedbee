export type OsvUnavailableErrorCode =
  | "OSV_REQUEST_ABORTED"
  | "OSV_REQUEST_TIMEOUT"
  | "OSV_NETWORK_UNAVAILABLE"
  | "OSV_RATE_LIMITED"
  | "OSV_SERVICE_UNAVAILABLE";

export type OsvAnalysisErrorCode =
  | "OSV_HTTP_REJECTED"
  | "OSV_REDIRECT_REJECTED"
  | "OSV_RESPONSE_INVALID"
  | "OSV_RESPONSE_TOO_LARGE"
  | "OSV_PAGINATION_INVALID"
  | "OSV_QUERY_LIMIT_EXCEEDED";

export class OsvUnavailableError extends Error {
  readonly code: OsvUnavailableErrorCode;

  constructor(code: OsvUnavailableErrorCode, message: string) {
    super(message);
    this.name = "OsvUnavailableError";
    this.code = code;
    Object.freeze(this);
  }
}

export class OsvAnalysisError extends Error {
  readonly code: OsvAnalysisErrorCode;

  constructor(code: OsvAnalysisErrorCode, message: string) {
    super(message);
    this.name = "OsvAnalysisError";
    this.code = code;
    Object.freeze(this);
  }
}
