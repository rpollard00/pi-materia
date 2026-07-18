import {
  centralAdminModeMetadata,
  centralConnectedModeMetadata,
  type CatalogItemKind,
  type CatalogItemSummary,
  type CatalogQuery,
  type ControlPlaneModeMetadata,
  type ControlPlanePorts,
  type CreateCatalogItemInput,
  type CreateModelPolicyInput,
  type DeleteCatalogItemInput,
  type DeleteModelPolicyInput,
  type SetActiveModelPolicyInput,
  type TelemetryEventFilter,
  type TelemetryIngestInput,
  type UpdateCatalogItemInput,
  type UpdateModelPolicyInput,
} from "../../application/controlPlane.js";
import {
  DEFAULT_CENTRAL_REQUEST_TIMEOUT_MS,
  type CentralCredentialConfig,
} from "../config/index.js";
import { CentralHttpNotFoundError } from "./errors.js";
import {
  CentralHttpTransport,
  type CentralHttpFetch,
} from "./httpTransport.js";
import {
  readActivePolicyResponse,
  readAdminMetadataResponse,
  readCatalogHeadResponse,
  readCatalogItemResponse,
  readCatalogListResponse,
  readCatalogWriteResponse,
  readModelCatalogResponse,
  readModelPolicyWriteResponse,
  readPolicyListResponse,
  readPolicyResponse,
  readStatusResponse,
  readTelemetryEventsResponse,
  readTelemetryIngestResponse,
} from "./responseValidation.js";

export type CentralHttpClientMode = "central-connected" | "central-admin";

/** Configuration for the HTTP adapter. HTTP-only concerns do not enter ports. */
export interface CentralHttpControlPlaneClientOptions {
  /** Absolute central server base URL. Preferred name, matching runtime config. */
  readonly apiUrl?: string;
  /** Compatibility alias for callers that name an HTTP endpoint `baseUrl`. */
  readonly baseUrl?: string;
  readonly requestTimeoutMs?: number;
  readonly credentials?: CentralCredentialConfig;
  /** Convenience credential aliases; when present they override `credentials`. */
  readonly readToken?: string;
  readonly adminToken?: string;
  readonly telemetryToken?: string;
  /** Additional attempts after the first attempt, safe GET requests only (0-5). */
  readonly maxReadRetries?: number;
  /** Compatibility alias for `maxReadRetries`. */
  readonly readRetryCount?: number;
  readonly retryDelayMs?: number;
  readonly fetch?: CentralHttpFetch;
  /** Caller lifecycle signal. Aborting it cancels current/future operations. */
  readonly signal?: AbortSignal;
  /** Compatibility alias for `signal`. */
  readonly abortSignal?: AbortSignal;
  /** `central-connected` by default; admin shells may select `central-admin`. */
  readonly mode?: CentralHttpClientMode;
  readonly label?: string;
}

/** The transport-backed implementation of all four control-plane ports. */
export interface CentralHttpControlPlaneClient extends ControlPlanePorts {}

/**
 * Create HTTP-backed central catalog, model-policy, telemetry/status, and admin
 * ports. Reads use the reader credential, writes use the admin credential, and
 * ingestion uses the telemetry credential.
 */
export function createCentralHttpControlPlaneClient(
  options: CentralHttpControlPlaneClientOptions,
): CentralHttpControlPlaneClient {
  const apiUrl = resolveApiUrl(options);
  const signal = resolveSignal(options);
  const maxReadRetries = resolveReadRetries(options);
  const credentials = resolveCredentials(options);
  const transport = new CentralHttpTransport({
    baseUrl: apiUrl,
    requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_CENTRAL_REQUEST_TIMEOUT_MS,
    ...(maxReadRetries !== undefined ? { maxReadRetries } : {}),
    ...(options.retryDelayMs !== undefined ? { retryDelayMs: options.retryDelayMs } : {}),
    ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
    ...(signal !== undefined ? { signal } : {}),
  });
  const mode = buildMode(options.mode ?? "central-connected", transport.baseUrl, options.label);

  const listCatalog = async (query: CatalogQuery | undefined, token: string | undefined): Promise<CatalogItemSummary[]> => {
    const searchParams = new URLSearchParams();
    if (query?.kind !== undefined) searchParams.set("kind", query.kind);
    if (query?.search !== undefined && query.search.length > 0) searchParams.set("search", query.search);
    const suffix = searchParams.size > 0 ? `?${searchParams.toString()}` : "";
    return transport.request({ path: `/api/catalog${suffix}`, token, validate: readCatalogListResponse });
  };

  const resolveCatalogKind = async (
    id: string,
    kind: CatalogItemKind | undefined,
    token: string | undefined,
  ): Promise<CatalogItemKind | undefined> => {
    if (kind !== undefined) return kind;
    const matches = (await listCatalog(undefined, token))
      .filter((summary) => summary.id === id)
      .sort((left, right) => left.kind.localeCompare(right.kind));
    return matches[0]?.kind;
  };

  const requireCatalogKind = async (
    id: string,
    kind: CatalogItemKind | undefined,
    token: string | undefined,
    method: "PATCH" | "DELETE",
  ): Promise<CatalogItemKind> => {
    const resolved = await resolveCatalogKind(id, kind, token);
    if (resolved !== undefined) return resolved;
    throw new CentralHttpNotFoundError(`Central catalog item "${id}" was not found`, {
      method,
      url: `${transport.baseUrl}/api/catalog/${encodeURIComponent(id)}`,
      code: "not_found",
    });
  };

  const catalog: ControlPlanePorts["catalog"] = {
    mode: () => mode,
    list: (query) => listCatalog(query, credentials.readToken),
    async get(id, kind) {
      const resolvedKind = await resolveCatalogKind(id, kind, credentials.readToken);
      if (resolvedKind === undefined) return undefined;
      try {
        return await transport.request({
          path: catalogItemPath(resolvedKind, id),
          token: credentials.readToken,
          validate: readCatalogItemResponse,
        });
      } catch (error) {
        if (error instanceof CentralHttpNotFoundError) return undefined;
        throw error;
      }
    },
    async head(id, kind) {
      if (kind === undefined) {
        const summaries = await listCatalog(undefined, credentials.readToken);
        return summaries
          .filter((summary) => summary.id === id)
          .sort((left, right) => left.kind.localeCompare(right.kind))[0];
      }
      try {
        return await transport.request({
          path: `${catalogItemPath(kind, id)}/summary`,
          token: credentials.readToken,
          validate: readCatalogHeadResponse,
        });
      } catch (error) {
        if (error instanceof CentralHttpNotFoundError) return undefined;
        throw error;
      }
    },
  };

  const modelPolicy: ControlPlanePorts["modelPolicy"] = {
    mode: () => mode,
    async getActivePolicy() {
      const response = await transport.request({
        path: "/api/model-policy",
        token: credentials.readToken,
        validate: readActivePolicyResponse,
      });
      return response.policy;
    },
    async getActivePolicyId() {
      const response = await transport.request({
        path: "/api/model-policy",
        token: credentials.readToken,
        validate: readActivePolicyResponse,
      });
      return response.activePolicyId;
    },
    listPolicies: () => transport.request({
      path: "/api/model-policy/policies",
      token: credentials.readToken,
      validate: readPolicyListResponse,
    }),
    async getPolicy(id) {
      try {
        return await transport.request({
          path: `/api/model-policy/policies/${encodeURIComponent(id)}`,
          token: credentials.readToken,
          validate: readPolicyResponse,
        });
      } catch (error) {
        if (error instanceof CentralHttpNotFoundError) return undefined;
        throw error;
      }
    },
    getModelCatalog: () => transport.request({
      path: "/api/model-catalog",
      token: credentials.readToken,
      validate: readModelCatalogResponse,
    }),
  };

  const telemetry: ControlPlanePorts["telemetry"] = {
    mode: () => mode,
    ingest: (input: TelemetryIngestInput) => transport.request({
      path: "/api/telemetry/ingest",
      method: "POST",
      token: credentials.telemetryToken,
      body: input,
      validate: readTelemetryIngestResponse,
    }),
    status: () => transport.request({
      path: "/api/status",
      token: credentials.readToken,
      validate: readStatusResponse,
    }),
    queryEvents: (filter?: TelemetryEventFilter) => {
      const searchParams = telemetryFilterParams(filter);
      const suffix = searchParams.size > 0 ? `?${searchParams.toString()}` : "";
      return transport.request({
        path: `/api/telemetry/events${suffix}`,
        token: credentials.readToken,
        validate: readTelemetryEventsResponse,
      });
    },
  };

  const admin: ControlPlanePorts["admin"] = {
    mode: () => mode,
    getMetadata: () => transport.request({
      path: "/api/admin",
      token: credentials.readToken,
      validate: readAdminMetadataResponse,
    }),
    createCatalogItem: (input: CreateCatalogItemInput) => transport.request({
      path: "/api/catalog",
      method: "POST",
      token: credentials.adminToken,
      body: catalogCreateBody(input),
      validate: (value) => readCatalogWriteResponse(value, "created"),
    }),
    async updateCatalogItem(input: UpdateCatalogItemInput) {
      const kind = await requireCatalogKind(input.id, input.kind, credentials.adminToken, "PATCH");
      const query = expectedVersionQuery(input.expectedVersion);
      return transport.request({
        path: `${catalogItemPath(kind, input.id)}${query}`,
        method: "PATCH",
        token: credentials.adminToken,
        body: catalogUpdateBody(input),
        validate: (value) => readCatalogWriteResponse(value, "updated"),
      });
    },
    async deleteCatalogItem(input: DeleteCatalogItemInput) {
      const kind = await requireCatalogKind(input.id, input.kind, credentials.adminToken, "DELETE");
      const query = expectedVersionQuery(input.expectedVersion);
      return transport.request({
        path: `${catalogItemPath(kind, input.id)}${query}`,
        method: "DELETE",
        token: credentials.adminToken,
        validate: (value) => readCatalogWriteResponse(value, "deleted"),
      });
    },
    createModelPolicy: (input: CreateModelPolicyInput) => transport.request({
      path: "/api/model-policy/policies",
      method: "POST",
      token: credentials.adminToken,
      body: policyCreateBody(input),
      validate: (value) => readModelPolicyWriteResponse(value, "created"),
    }),
    updateModelPolicy: (input: UpdateModelPolicyInput) => transport.request({
      path: `/api/model-policy/policies/${encodeURIComponent(input.id)}${expectedVersionQuery(input.expectedVersion)}`,
      method: "PATCH",
      token: credentials.adminToken,
      body: policyUpdateBody(input),
      validate: (value) => readModelPolicyWriteResponse(value, "updated"),
    }),
    deleteModelPolicy: (input: DeleteModelPolicyInput) => transport.request({
      path: `/api/model-policy/policies/${encodeURIComponent(input.id)}${expectedVersionQuery(input.expectedVersion)}`,
      method: "DELETE",
      token: credentials.adminToken,
      validate: (value) => readModelPolicyWriteResponse(value, "deleted"),
    }),
    setActiveModelPolicy: (input: SetActiveModelPolicyInput) => transport.request({
      path: "/api/model-policy/active",
      method: "POST",
      token: credentials.adminToken,
      body: { id: input.id },
      validate: (value) => readModelPolicyWriteResponse(value, "activated"),
    }),
  };

  return { catalog, modelPolicy, telemetry, admin };
}

/** Compatibility factory name emphasizing that the returned value is ports. */
export const createCentralHttpControlPlanePorts = createCentralHttpControlPlaneClient;

function resolveApiUrl(options: CentralHttpControlPlaneClientOptions): string {
  if (options.apiUrl !== undefined && options.baseUrl !== undefined && options.apiUrl !== options.baseUrl) {
    throw new TypeError("Central HTTP client apiUrl and baseUrl must match when both are provided.");
  }
  const value = options.apiUrl ?? options.baseUrl;
  if (value === undefined) throw new TypeError("Central HTTP client requires apiUrl.");
  return value;
}

function resolveSignal(options: CentralHttpControlPlaneClientOptions): AbortSignal | undefined {
  if (options.signal !== undefined && options.abortSignal !== undefined && options.signal !== options.abortSignal) {
    throw new TypeError("Central HTTP client signal and abortSignal must reference the same signal when both are provided.");
  }
  return options.signal ?? options.abortSignal;
}

function resolveReadRetries(options: CentralHttpControlPlaneClientOptions): number | undefined {
  if (
    options.maxReadRetries !== undefined
    && options.readRetryCount !== undefined
    && options.maxReadRetries !== options.readRetryCount
  ) {
    throw new TypeError("Central HTTP client maxReadRetries and readRetryCount must match when both are provided.");
  }
  return options.maxReadRetries ?? options.readRetryCount;
}

function resolveCredentials(options: CentralHttpControlPlaneClientOptions): CentralCredentialConfig {
  const credentials = options.credentials ?? {};
  return {
    ...(options.readToken ?? credentials.readToken) !== undefined
      ? { readToken: options.readToken ?? credentials.readToken }
      : {},
    ...(options.adminToken ?? credentials.adminToken) !== undefined
      ? { adminToken: options.adminToken ?? credentials.adminToken }
      : {},
    ...(options.telemetryToken ?? credentials.telemetryToken) !== undefined
      ? { telemetryToken: options.telemetryToken ?? credentials.telemetryToken }
      : {},
  };
}

function buildMode(mode: CentralHttpClientMode, apiUrl: string, label: string | undefined): ControlPlaneModeMetadata {
  const metadata = { centralApiBaseUrl: apiUrl, ...(label !== undefined ? { label } : {}) };
  return mode === "central-admin" ? centralAdminModeMetadata(metadata) : centralConnectedModeMetadata(metadata);
}

function catalogItemPath(kind: CatalogItemKind, id: string): string {
  return `/api/catalog/${kind}/${encodeURIComponent(id)}`;
}

function expectedVersionQuery(expectedVersion: string | undefined): string {
  if (expectedVersion === undefined || expectedVersion.length === 0) return "";
  const params = new URLSearchParams({ expectedVersion });
  return `?${params.toString()}`;
}

function telemetryFilterParams(filter: TelemetryEventFilter | undefined): URLSearchParams {
  const params = new URLSearchParams();
  if (filter?.runtimeId !== undefined) params.set("runtimeId", filter.runtimeId);
  if (filter?.castId !== undefined) params.set("castId", filter.castId);
  if (filter?.sinceSequence !== undefined) params.set("sinceSequence", String(filter.sinceSequence));
  if (filter?.limit !== undefined) params.set("limit", String(filter.limit));
  return params;
}

function catalogCreateBody(input: CreateCatalogItemInput): Omit<CreateCatalogItemInput, "principalId"> {
  return {
    id: input.id,
    kind: input.kind,
    content: input.content,
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.provenance !== undefined ? { provenance: input.provenance } : {}),
  };
}

function catalogUpdateBody(input: UpdateCatalogItemInput): Omit<UpdateCatalogItemInput, "id" | "kind" | "principalId" | "expectedVersion"> {
  return {
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.content !== undefined ? { content: input.content } : {}),
    ...(input.provenance !== undefined ? { provenance: input.provenance } : {}),
  };
}

function policyCreateBody(input: CreateModelPolicyInput): Omit<CreateModelPolicyInput, "principalId"> {
  return {
    id: input.id,
    document: input.document,
    ...(input.setActive !== undefined ? { setActive: input.setActive } : {}),
  };
}

function policyUpdateBody(input: UpdateModelPolicyInput): Omit<UpdateModelPolicyInput, "id" | "principalId" | "expectedVersion"> {
  return {
    ...(input.document !== undefined ? { document: input.document } : {}),
    ...(input.setActive !== undefined ? { setActive: input.setActive } : {}),
  };
}
