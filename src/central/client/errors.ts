/**
 * Typed failures exposed by the central HTTP control-plane adapter.
 *
 * These errors belong to the transport adapter. Application/domain ports remain
 * HTTP-agnostic and continue to exchange only control-plane DTOs.
 */

export interface CentralHttpErrorContext {
  readonly method: string;
  readonly url: string;
  readonly status?: number;
  readonly code?: string;
}

/** Base class for every failure produced by the central HTTP client. */
export class CentralHttpClientError extends Error {
  readonly method: string;
  readonly url: string;
  readonly status?: number;
  readonly code?: string;

  constructor(message: string, context: CentralHttpErrorContext, options?: ErrorOptions) {
    super(message, options);
    this.name = "CentralHttpClientError";
    this.method = context.method;
    this.url = context.url;
    if (context.status !== undefined) this.status = context.status;
    if (context.code !== undefined) this.code = context.code;
  }
}

/** The central server rejected or could not resolve the bearer credential. */
export class CentralHttpUnauthorizedError extends CentralHttpClientError {
  readonly status = 401;
  readonly reason?: string;

  constructor(message: string, context: Omit<CentralHttpErrorContext, "status">, reason?: string) {
    super(message, { ...context, status: 401 });
    this.name = "CentralHttpUnauthorizedError";
    if (reason !== undefined) this.reason = reason;
  }
}

/** The credential was valid but did not grant the route permission. */
export class CentralHttpForbiddenError extends CentralHttpClientError {
  readonly status = 403;
  readonly permission?: string;

  constructor(message: string, context: Omit<CentralHttpErrorContext, "status">, permission?: string) {
    super(message, { ...context, status: 403 });
    this.name = "CentralHttpForbiddenError";
    if (permission !== undefined) this.permission = permission;
  }
}

/** The requested central resource or route does not exist. */
export class CentralHttpNotFoundError extends CentralHttpClientError {
  readonly status = 404;

  constructor(message: string, context: Omit<CentralHttpErrorContext, "status">) {
    super(message, { ...context, status: 404 });
    this.name = "CentralHttpNotFoundError";
  }
}

/** A write conflicted with current central state (including version mismatch). */
export class CentralHttpConflictError extends CentralHttpClientError {
  readonly status = 409;
  readonly currentVersion?: string;

  constructor(
    message: string,
    context: Omit<CentralHttpErrorContext, "status">,
    currentVersion?: string,
  ) {
    super(message, { ...context, status: 409 });
    this.name = "CentralHttpConflictError";
    if (currentVersion !== undefined) this.currentVersion = currentVersion;
  }
}

/** A non-specialized non-2xx HTTP status. */
export class CentralHttpStatusError extends CentralHttpClientError {
  constructor(message: string, context: CentralHttpErrorContext) {
    super(message, context);
    this.name = "CentralHttpStatusError";
  }
}

/** The server returned JSON that did not match the expected endpoint envelope. */
export class CentralHttpResponseValidationError extends CentralHttpClientError {
  constructor(message: string, context: CentralHttpErrorContext, options?: ErrorOptions) {
    super(message, context, options);
    this.name = "CentralHttpResponseValidationError";
  }
}

/** One request attempt exceeded the configured timeout. */
export class CentralHttpTimeoutError extends CentralHttpClientError {
  readonly timeoutMs: number;

  constructor(message: string, context: CentralHttpErrorContext, timeoutMs: number, options?: ErrorOptions) {
    super(message, context, options);
    this.name = "CentralHttpTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

/** The caller-supplied abort signal cancelled the operation. */
export class CentralHttpAbortError extends CentralHttpClientError {
  constructor(message: string, context: CentralHttpErrorContext, options?: ErrorOptions) {
    super(message, context, options);
    this.name = "CentralHttpAbortError";
  }
}

/** Fetch failed before an HTTP response was received. */
export class CentralHttpNetworkError extends CentralHttpClientError {
  constructor(message: string, context: CentralHttpErrorContext, options?: ErrorOptions) {
    super(message, context, options);
    this.name = "CentralHttpNetworkError";
  }
}

// Concise aliases retained for consumers that do not include the transport name
// in local imports. They reference the same constructors, so instanceof works.
export {
  CentralHttpUnauthorizedError as CentralUnauthorizedError,
  CentralHttpForbiddenError as CentralForbiddenError,
  CentralHttpNotFoundError as CentralNotFoundError,
  CentralHttpConflictError as CentralConflictError,
};
