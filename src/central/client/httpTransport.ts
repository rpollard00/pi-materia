import {
  CentralHttpAbortError,
  CentralHttpClientError,
  CentralHttpConflictError,
  CentralHttpForbiddenError,
  CentralHttpNetworkError,
  CentralHttpNotFoundError,
  CentralHttpResponseValidationError,
  CentralHttpStatusError,
  CentralHttpTimeoutError,
  CentralHttpUnauthorizedError,
  type CentralHttpErrorContext,
} from "./errors.js";

/** Fetch boundary injected by fake servers/tests or implemented by global fetch. */
export type CentralHttpFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export const DEFAULT_CENTRAL_HTTP_READ_RETRIES = 2;
export const MAX_CENTRAL_HTTP_READ_RETRIES = 5;
export const DEFAULT_CENTRAL_HTTP_RETRY_DELAY_MS = 50;
const MAX_ERROR_MESSAGE_LENGTH = 1_000;
const MAX_RESPONSE_BODY_LENGTH = 2_000_000;

export interface CentralHttpTransportOptions {
  readonly baseUrl: string;
  readonly requestTimeoutMs: number;
  /** Additional attempts after the first attempt for safe GET requests. */
  readonly maxReadRetries?: number;
  /** Base delay between safe-read attempts. Set to zero in deterministic tests. */
  readonly retryDelayMs?: number;
  readonly fetch?: CentralHttpFetch;
  /** Lifecycle signal shared by all requests made through this client. */
  readonly signal?: AbortSignal;
}

export interface CentralHttpRequest<T> {
  readonly path: string;
  readonly method?: "GET" | "POST" | "PATCH" | "DELETE";
  readonly token?: string;
  readonly body?: unknown;
  /** Decode and validate a successful endpoint envelope. */
  readonly validate: (body: unknown) => T;
}

/**
 * Focused HTTP transport used by the four control-plane port adapters.
 *
 * It owns bearer headers, timeout/abort composition, JSON parsing, typed status
 * failures, and bounded retries. DTO-specific decoding is supplied by the port
 * adapter and wrapped as a typed response-validation failure here.
 */
export class CentralHttpTransport {
  readonly #baseUrl: string;
  readonly #requestTimeoutMs: number;
  readonly #maxReadRetries: number;
  readonly #retryDelayMs: number;
  readonly #fetch: CentralHttpFetch;
  readonly #signal?: AbortSignal;

  constructor(options: CentralHttpTransportOptions) {
    this.#baseUrl = normalizeBaseUrl(options.baseUrl);
    this.#requestTimeoutMs = positiveInteger(options.requestTimeoutMs, "requestTimeoutMs");
    this.#maxReadRetries = boundedInteger(
      options.maxReadRetries ?? DEFAULT_CENTRAL_HTTP_READ_RETRIES,
      "maxReadRetries",
      0,
      MAX_CENTRAL_HTTP_READ_RETRIES,
    );
    this.#retryDelayMs = boundedInteger(
      options.retryDelayMs ?? DEFAULT_CENTRAL_HTTP_RETRY_DELAY_MS,
      "retryDelayMs",
      0,
      60_000,
    );
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#signal = options.signal;
  }

  get baseUrl(): string {
    return this.#baseUrl;
  }

  async request<T>(request: CentralHttpRequest<T>): Promise<T> {
    const method = request.method ?? "GET";
    const url = `${this.#baseUrl}${request.path}`;
    const context: CentralHttpErrorContext = { method, url };
    const retries = method === "GET" ? this.#maxReadRetries : 0;

    for (let attempt = 0; ; attempt++) {
      try {
        return await this.#requestOnce(request, method, url);
      } catch (error) {
        const typed = normalizeRequestFailure(error, context, this.#requestTimeoutMs, this.#signal);
        if (attempt >= retries || !isRetryableReadFailure(typed)) throw typed;
        await abortableDelay(this.#retryDelayMs * 2 ** attempt, this.#signal, context);
      }
    }
  }

  async #requestOnce<T>(
    request: CentralHttpRequest<T>,
    method: NonNullable<CentralHttpRequest<T>["method"]>,
    url: string,
  ): Promise<T> {
    const context: CentralHttpErrorContext = { method, url };
    if (this.#signal?.aborted) {
      throw new CentralHttpAbortError(`Central request aborted before ${method} ${url}`, context);
    }

    const controller = new AbortController();
    let timedOut = false;
    const abortFromCaller = () => controller.abort(this.#signal?.reason);
    this.#signal?.addEventListener("abort", abortFromCaller, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error(`Central request timed out after ${this.#requestTimeoutMs}ms`));
    }, this.#requestTimeoutMs);

    const headers: Record<string, string> = { accept: "application/json" };
    if (request.token !== undefined) headers.authorization = `Bearer ${request.token}`;
    if (request.body !== undefined) headers["content-type"] = "application/json";

    try {
      const serializedBody = request.body === undefined ? undefined : JSON.stringify(request.body);
      const response = await this.#fetch(url, {
        method,
        headers,
        ...(serializedBody !== undefined ? { body: serializedBody } : {}),
        signal: controller.signal,
      });
      const json = response.ok
        ? await readResponseJson(response, context)
        : await readErrorResponseJson(response);
      if (!response.ok) throw statusError(response.status, json, context);
      try {
        return request.validate(json);
      } catch (error) {
        if (error instanceof CentralHttpClientError) throw error;
        const detail = error instanceof Error ? error.message : String(error);
        throw new CentralHttpResponseValidationError(
          `Invalid response from ${method} ${url}: ${detail}`,
          { ...context, status: response.status },
          { cause: error },
        );
      }
    } catch (error) {
      if (timedOut) {
        throw new CentralHttpTimeoutError(
          `Central request timed out after ${this.#requestTimeoutMs}ms: ${method} ${url}`,
          context,
          this.#requestTimeoutMs,
          { cause: error },
        );
      }
      if (this.#signal?.aborted) {
        throw new CentralHttpAbortError(`Central request aborted: ${method} ${url}`, context, { cause: error });
      }
      if (error instanceof CentralHttpClientError) throw error;
      throw new CentralHttpNetworkError(`Central request failed before receiving a response: ${method} ${url}`, context, {
        cause: error,
      });
    } finally {
      clearTimeout(timer);
      this.#signal?.removeEventListener("abort", abortFromCaller);
    }
  }
}

function normalizeBaseUrl(value: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError("Central HTTP client baseUrl must be a non-empty absolute http(s) URL.");
  }
  const trimmed = value.trim().replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new TypeError("Central HTTP client baseUrl must be a non-empty absolute http(s) URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new TypeError("Central HTTP client baseUrl must use http or https.");
  }
  return trimmed;
}

async function readResponseJson(response: Response, context: CentralHttpErrorContext): Promise<unknown> {
  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    throw new CentralHttpResponseValidationError(
      `Could not read response body from ${context.method} ${context.url}`,
      { ...context, status: response.status },
      { cause: error },
    );
  }
  if (text.length > MAX_RESPONSE_BODY_LENGTH) {
    throw new CentralHttpResponseValidationError(
      `Response body from ${context.method} ${context.url} exceeded ${MAX_RESPONSE_BODY_LENGTH} characters`,
      { ...context, status: response.status },
    );
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new CentralHttpResponseValidationError(
      `Response from ${context.method} ${context.url} was not valid JSON`,
      { ...context, status: response.status },
      { cause: error },
    );
  }
}

/** Error status is authoritative even when an intermediary returns non-JSON. */
async function readErrorResponseJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length > MAX_RESPONSE_BODY_LENGTH) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return {};
  }
}

function statusError(status: number, body: unknown, context: CentralHttpErrorContext): CentralHttpClientError {
  const envelope = isPlainObject(body) ? body : {};
  const message = readErrorMessage(envelope.error, status, context);
  const code = optionalString(envelope.code);
  const typedContext = { ...context, ...(code !== undefined ? { code } : {}) };

  if (status === 401) {
    return new CentralHttpUnauthorizedError(message, typedContext, optionalString(envelope.reason));
  }
  if (status === 403) {
    return new CentralHttpForbiddenError(message, typedContext, optionalString(envelope.permission));
  }
  if (status === 404) return new CentralHttpNotFoundError(message, typedContext);
  if (status === 409) {
    return new CentralHttpConflictError(message, typedContext, optionalString(envelope.currentVersion));
  }
  return new CentralHttpStatusError(message, { ...typedContext, status });
}

function readErrorMessage(value: unknown, status: number, context: CentralHttpErrorContext): string {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.length <= MAX_ERROR_MESSAGE_LENGTH ? value : `${value.slice(0, MAX_ERROR_MESSAGE_LENGTH)}…`;
  }
  return `Central request failed with HTTP ${status}: ${context.method} ${context.url}`;
}

function normalizeRequestFailure(
  error: unknown,
  context: CentralHttpErrorContext,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): CentralHttpClientError {
  if (error instanceof CentralHttpClientError) return error;
  if (signal?.aborted) {
    return new CentralHttpAbortError(`Central request aborted: ${context.method} ${context.url}`, context, { cause: error });
  }
  if (isAbortLike(error)) {
    return new CentralHttpTimeoutError(
      `Central request timed out after ${timeoutMs}ms: ${context.method} ${context.url}`,
      context,
      timeoutMs,
      { cause: error },
    );
  }
  return new CentralHttpNetworkError(
    `Central request failed before receiving a response: ${context.method} ${context.url}`,
    context,
    { cause: error },
  );
}

function isRetryableReadFailure(error: CentralHttpClientError): boolean {
  if (error instanceof CentralHttpNetworkError || error instanceof CentralHttpTimeoutError) return true;
  if (!(error instanceof CentralHttpStatusError)) return false;
  return error.status === 408 || error.status === 429 || (error.status !== undefined && error.status >= 500 && error.status <= 599);
}

async function abortableDelay(ms: number, signal: AbortSignal | undefined, context: CentralHttpErrorContext): Promise<void> {
  if (signal?.aborted) throw new CentralHttpAbortError("Central request aborted during retry delay", context);
  if (ms <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(finish, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(new CentralHttpAbortError("Central request aborted during retry delay", context));
    };
    function finish(): void {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    // Close the small race between the pre-check above and listener setup.
    if (signal?.aborted) onAbort();
  });
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`Central HTTP client ${name} must be a positive integer.`);
  return value;
}

function boundedInteger(value: number, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`Central HTTP client ${name} must be an integer from ${minimum} through ${maximum}.`);
  }
  return value;
}

function isAbortLike(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
