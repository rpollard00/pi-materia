import { createHash, randomUUID } from "node:crypto";
import type { ScopePath } from "../domain/scope.js";
import {
  loadCentralConnectedRuntimeConfig,
  type CentralConnectedRuntimeConfig,
} from "../central/config/index.js";
import { loadProfileConfig } from "../config/config.js";
import type { MateriaCastState } from "../types.js";
import type {
  CentralTelemetrySinkResolution,
  CentralTelemetrySinkResolver,
} from "../runtime/nativeEventing.js";

export const CENTRAL_TELEMETRY_SINK_ID = "central-telemetry";
export const DEFAULT_CENTRAL_TELEMETRY_MAX_QUEUE_SIZE = 256;
export const DEFAULT_CENTRAL_TELEMETRY_MAX_RETRIES = 2;
export const DEFAULT_CENTRAL_TELEMETRY_RETRY_BACKOFF_MS = 100;
export const DEFAULT_CENTRAL_TELEMETRY_MAX_BACKOFF_MS = 1_000;

export interface CentralConnectedTelemetrySinkResolverOptions {
  /** Resolve opt-in connection settings. Undefined guarantees no central I/O. */
  readonly resolveRuntimeConfig?: () => Promise<CentralConnectedRuntimeConfig | undefined>;
  /** Process identity seam used by tests. Called at most once per resolver. */
  readonly createRuntimeId?: () => string;
  /** Scope fallback seam. Production uses a non-reversible project-path hash. */
  readonly resolveFallbackScope?: (state: MateriaCastState) => ScopePath;
}

/**
 * Adapt central-connected runtime configuration to the existing generic webhook
 * sink contract. This is telemetry fan-out only: it contributes a sink to the
 * cast event bus and owns no lifecycle, claim, routing, or agent_router state.
 */
export function createCentralConnectedTelemetrySinkResolver(
  options: CentralConnectedTelemetrySinkResolverOptions = {},
): CentralTelemetrySinkResolver {
  const resolveRuntimeConfig = options.resolveRuntimeConfig ?? defaultRuntimeConfigResolver;
  const processRuntimeId = (options.createRuntimeId ?? randomUUID)();
  const fallbackScope = options.resolveFallbackScope ?? localProjectScope;

  return {
    async resolve(state): Promise<CentralTelemetrySinkResolution | undefined> {
      const config = await resolveRuntimeConfig();
      if (!config) return undefined;

      const token = config.credentials.telemetryToken;
      if (!token) {
        return {
          diagnostic: {
            severity: "warning",
            reason: "telemetry_credential_missing",
            message: "Central telemetry is configured but no telemetry credential is available; delivery is disabled.",
          },
        };
      }

      const runtimeId = config.runtimeId ?? processRuntimeId;
      const scope = config.scope ?? fallbackScope(state);
      return {
        sink: {
          id: CENTRAL_TELEMETRY_SINK_ID,
          kind: "webhook",
          enabled: true,
          url: telemetryIngestUrl(config.apiUrl),
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
          bodyTemplate: "envelope",
          bodyMapping: { static: { runtimeId, scope } },
          timeoutMs: config.requestTimeoutMs,
          maxRetries: DEFAULT_CENTRAL_TELEMETRY_MAX_RETRIES,
          retryBackoffMs: DEFAULT_CENTRAL_TELEMETRY_RETRY_BACKOFF_MS,
          maxBackoffMs: DEFAULT_CENTRAL_TELEMETRY_MAX_BACKOFF_MS,
          discardingAfter: 10,
          maxQueueSize: DEFAULT_CENTRAL_TELEMETRY_MAX_QUEUE_SIZE,
        },
        diagnostic: {
          severity: "info",
          reason: "active",
          message: "Central telemetry fan-out is active through the runtime event bus.",
        },
      };
    },
  };
}

async function defaultRuntimeConfigResolver(): Promise<CentralConnectedRuntimeConfig | undefined> {
  const profile = await loadProfileConfig();
  return loadCentralConnectedRuntimeConfig({ profile });
}

function telemetryIngestUrl(apiUrl: string): string {
  return `${apiUrl.trim().replace(/\/+$/, "")}/api/telemetry/ingest`;
}

/**
 * Supply useful project scope without exposing the local checkout path. A real
 * enterprise scope from connected-runtime configuration always takes priority.
 */
function localProjectScope(state: MateriaCastState): ScopePath {
  const projectHash = createHash("sha256").update(state.cwd).digest("hex").slice(0, 24);
  return { tenantId: "local", projectScopeId: `project-${projectHash}` };
}
