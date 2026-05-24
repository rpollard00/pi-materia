export type ContextErrorRecoveryAction = "compact" | "retry_without_compaction" | "skip";

export interface NormalizedProviderError {
  type?: string;
  code?: string;
  param?: string;
  message?: string;
}

export interface ContextErrorRecoveryDecision {
  action: ContextErrorRecoveryAction;
  provider: NormalizedProviderError;
  strongContextSignal: boolean;
  transientProviderSignal: boolean;
  message: string;
}

/**
 * Pure provider-error policy for context-window recovery.
 *
 * Provider context errors are only compaction candidates when the provider
 * payload (or, as a fallback, the wrapper text) gives a strong context-window
 * signal. Transient/reachability signals always win so generic server errors
 * are not mistaken for context pressure just because wrapper text mentions
 * context.
 */
export function evaluateContextErrorRecovery(error: unknown): ContextErrorRecoveryDecision {
  const message = error instanceof Error ? error.message : String(error);
  const provider = normalizeProviderError(message);
  const providerText = [provider.type, provider.code, provider.param, provider.message].filter(Boolean).join(" ");
  const searchText = providerText || message;
  const transientProviderSignal = hasTransientProviderSignal(provider, message);
  const strongContextSignal = !transientProviderSignal && hasStrongContextSignal(provider, searchText, Boolean(providerText));

  return {
    action: strongContextSignal ? "compact" : transientProviderSignal ? "retry_without_compaction" : "skip",
    provider,
    strongContextSignal,
    transientProviderSignal,
    message,
  };
}

function normalizeProviderError(message: string): NormalizedProviderError {
  for (const value of embeddedJsonValues(message)) {
    const candidate = providerErrorFromJson(value);
    if (candidate) return candidate;
  }
  return {};
}

function providerErrorFromJson(value: unknown): NormalizedProviderError | undefined {
  if (!isRecord(value)) return undefined;
  const nested = isRecord(value.error) ? value.error : value;
  const type = stringValue(nested.type);
  const code = stringValue(nested.code);
  const param = stringValue(nested.param);
  const providerMessage = stringValue(nested.message);
  if (!type && !code && !param && !providerMessage) return undefined;
  return { type, code, param, message: providerMessage };
}

function* embeddedJsonValues(text: string): Generator<unknown> {
  for (let start = text.indexOf("{"); start >= 0; start = text.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i += 1) {
      const char = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === "{") depth += 1;
      else if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          try {
            yield JSON.parse(text.slice(start, i + 1));
          } catch {
            // Keep scanning; wrapper text often contains non-JSON braces.
          }
          break;
        }
      }
    }
  }
}

function hasStrongContextSignal(provider: NormalizedProviderError, text: string, hasProviderPayload: boolean): boolean {
  const normalized = text.trim();
  if (!normalized) return false;
  if (provider.code === "context_length_exceeded" && (!provider.param || provider.param === "input")) return true;
  if (provider.type === "invalid_request_error" && /context[_-]?length[_-]?exceeded/i.test(normalized)) return true;
  if (hasProviderPayload && provider.param && provider.param !== "input") return false;
  return /context[_-]?length[_-]?exceeded|context[_-]?window[_-]?exceeded|input exceeds the context window|context (window|length|limit|overflow)|token limit|max(?:imum)? tokens|input too long|request too large|too many tokens/i.test(normalized);
}

function hasTransientProviderSignal(provider: NormalizedProviderError, fullMessage: string): boolean {
  const text = [provider.type, provider.code, provider.message || fullMessage].filter(Boolean).join(" ");
  return /\bserver_error\b|\bservice_unavailable\b|\btemporar(?:y|ily)\b|\btimeout\b|\btimed out\b|\bunavailable\b|\boverloaded\b|\breachab(?:le|ility)\b|connection (?:reset|refused|lost)|network error|retry your request|help center|request id/i.test(text);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
