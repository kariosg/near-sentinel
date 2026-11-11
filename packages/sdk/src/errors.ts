/** Base class for errors thrown by the SDK (as opposed to errors observed on the network). */
export class SentinelError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "SentinelError";
    this.code = code;
  }
}

/** The caller supplied invalid input. HTTP 400 in the API. */
export class SentinelInputError extends SentinelError {
  readonly issues?: unknown;
  constructor(message: string, issues?: unknown) {
    super("INVALID_INPUT", message);
    this.name = "SentinelInputError";
    this.issues = issues;
  }
}

/** A configured or user-supplied RPC URL failed the SSRF policy. */
export class SentinelUrlRejectedError extends SentinelError {
  constructor(message: string) {
    super("URL_REJECTED", message);
    this.name = "SentinelUrlRejectedError";
  }
}
