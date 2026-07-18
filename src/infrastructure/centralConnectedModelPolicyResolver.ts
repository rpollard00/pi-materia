import type { ModelPolicyPort } from "../application/controlPlane.js";
import {
  createCentralHttpControlPlaneClient,
  type CentralHttpControlPlaneClientOptions,
} from "../central/client/index.js";
import {
  loadCentralConnectedRuntimeConfig,
  type CentralConnectedRuntimeConfig,
} from "../central/config/index.js";
import { loadProfileConfig } from "../config/config.js";
import type { ModelPolicyDocument } from "../domain/modelPolicy.js";
import type { ModelPolicyResolver } from "../runtime/modelPolicyResolver.js";

/** Keep policy reads off the cast hot path while still refreshing regularly. */
export const DEFAULT_CENTRAL_MODEL_POLICY_CACHE_TTL_MS = 30_000;

export interface CentralConnectedModelPolicyResolverOptions {
  /** Resolve opt-in connection settings. Undefined guarantees local-only I/O. */
  readonly resolveRuntimeConfig?: () => Promise<CentralConnectedRuntimeConfig | undefined>;
  /** HTTP adapter seam used by tests; production uses the central HTTP client. */
  readonly createModelPolicyPort?: (options: CentralHttpControlPlaneClientOptions) => ModelPolicyPort;
  readonly cacheTtlMs?: number;
  readonly clock?: () => number;
}

interface ActiveConnection {
  readonly config: CentralConnectedRuntimeConfig;
  readonly port: ModelPolicyPort;
}

interface PolicyCache {
  /** A successful response may intentionally contain no active policy. */
  readonly policy: ModelPolicyDocument | undefined;
  readonly refreshAfter: number;
}

interface PolicyRefresh {
  readonly connection: ActiveConnection;
  readonly promise: Promise<ModelPolicyDocument | undefined>;
}

/**
 * Resolve the active central model policy for local casts when the runtime has
 * explicitly opted into a control plane. Successful reads (including an empty
 * active policy) are cached briefly. A failed refresh keeps the last successful
 * process-local value and is retried after the same bounded interval; with no
 * cached value, failure degrades to the local no-policy behavior.
 */
export function createCentralConnectedModelPolicyResolver(
  options: CentralConnectedModelPolicyResolverOptions = {},
): ModelPolicyResolver {
  const resolveRuntimeConfig = options.resolveRuntimeConfig ?? defaultRuntimeConfigResolver;
  const createModelPolicyPort = options.createModelPolicyPort ?? ((clientOptions) => (
    createCentralHttpControlPlaneClient(clientOptions).modelPolicy
  ));
  const cacheTtlMs = validateCacheTtl(options.cacheTtlMs ?? DEFAULT_CENTRAL_MODEL_POLICY_CACHE_TTL_MS);
  const clock = options.clock ?? Date.now;
  let connection: ActiveConnection | undefined;
  let cache: PolicyCache | undefined;
  let refresh: PolicyRefresh | undefined;
  let retryAfter = 0;

  return {
    async resolveActivePolicy() {
      let config: CentralConnectedRuntimeConfig | undefined;
      try {
        config = await resolveRuntimeConfig();
      } catch {
        // Secret-file/config resolution can fail transiently too. Never turn an
        // optional central dependency into a local cast failure.
        return cache?.policy;
      }

      if (!config) {
        connection = undefined;
        cache = undefined;
        refresh = undefined;
        retryAfter = 0;
        return undefined;
      }

      if (!connection || !sameRuntimeConfig(connection.config, config)) {
        try {
          connection = {
            config,
            port: createModelPolicyPort({
              apiUrl: config.apiUrl,
              requestTimeoutMs: config.requestTimeoutMs,
              credentials: config.credentials,
              mode: "central-connected",
            }),
          };
        } catch {
          connection = undefined;
          cache = undefined;
          refresh = undefined;
          retryAfter = clock() + cacheTtlMs;
          return undefined;
        }
        cache = undefined;
        refresh = undefined;
        retryAfter = 0;
      }

      const activeConnection = connection;
      const now = clock();
      if (cache && now < cache.refreshAfter) return cache.policy;
      if (now < retryAfter) return cache?.policy;
      if (refresh?.connection === activeConnection) return refresh.promise;

      const promise = activeConnection.port.getActivePolicy()
        .then((policy) => {
          if (connection === activeConnection) {
            cache = { policy, refreshAfter: clock() + cacheTtlMs };
            retryAfter = 0;
          }
          return policy;
        })
        .catch(() => {
          if (connection === activeConnection) retryAfter = clock() + cacheTtlMs;
          return connection === activeConnection ? cache?.policy : undefined;
        })
        .finally(() => {
          if (refresh?.promise === promise) refresh = undefined;
        });
      refresh = { connection: activeConnection, promise };
      return promise;
    },
  };
}

async function defaultRuntimeConfigResolver(): Promise<CentralConnectedRuntimeConfig | undefined> {
  const profile = await loadProfileConfig();
  return loadCentralConnectedRuntimeConfig({ profile });
}

function sameRuntimeConfig(
  left: CentralConnectedRuntimeConfig,
  right: CentralConnectedRuntimeConfig,
): boolean {
  return left.apiUrl === right.apiUrl
    && left.requestTimeoutMs === right.requestTimeoutMs
    && left.credentials.readToken === right.credentials.readToken
    && left.credentials.adminToken === right.credentials.adminToken
    && left.credentials.telemetryToken === right.credentials.telemetryToken;
}

function validateCacheTtl(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("Central model-policy cacheTtlMs must be a non-negative safe integer.");
  }
  return value;
}
