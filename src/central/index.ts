/**
 * Central control-plane module.
 *
 * Hosts the central server and its control-plane adapters, separate
 * from the local session WebUI server (src/webui) and from the local
 * control-plane adapter (src/infrastructure/localControlPlane). The central
 * server never couples to a local repository session
 * (docs/enterprise-control-plane.md §3.3, §4, §16.4). Auth + RBAC for central
 * routes lives in `./auth` (deployment static-bearer adapter today;
 * OAuth/OIDC is a future adapter boundary — §13).
 */
export {
  createMateriaCentralServer,
  type MateriaCentralServer,
  type MateriaCentralServerOptions,
} from "./server/index.js";

export {
  createCentralCatalogConfigSourceLoader,
  createCentralHttpControlPlaneClient,
  createCentralHttpControlPlanePorts,
  DEFAULT_CENTRAL_HTTP_READ_RETRIES,
  DEFAULT_CENTRAL_HTTP_RETRY_DELAY_MS,
  MAX_CENTRAL_HTTP_READ_RETRIES,
  CentralHttpTransport,
  CentralHttpClientError,
  CentralHttpUnauthorizedError,
  CentralHttpForbiddenError,
  CentralHttpNotFoundError,
  CentralHttpConflictError,
  CentralHttpStatusError,
  CentralHttpResponseValidationError,
  CentralHttpTimeoutError,
  CentralHttpAbortError,
  CentralHttpNetworkError,
  CentralUnauthorizedError,
  CentralForbiddenError,
  CentralNotFoundError,
  CentralConflictError,
  type CentralCatalogConfigSourceLoader,
  type CentralCatalogConfigSourceLoaderOptions,
  type CentralHttpClientMode,
  type CentralHttpControlPlaneClient,
  type CentralHttpControlPlaneClientOptions,
  type CentralHttpErrorContext,
  type CentralHttpFetch,
  type CentralHttpRequest,
  type CentralHttpTransportOptions,
} from "./client/index.js";

export {
  CENTRAL_CONFIG_ENV,
  DEFAULT_CENTRAL_AUTH_MODE,
  DEFAULT_CENTRAL_CORS_ORIGIN,
  DEFAULT_CENTRAL_DATABASE_PATH,
  DEFAULT_CENTRAL_HOST,
  DEFAULT_CENTRAL_PORT,
  DEFAULT_CENTRAL_REQUEST_TIMEOUT_MS,
  DEFAULT_CENTRAL_RETENTION_DAYS,
  loadCentralConnectedRuntimeConfig,
  loadCentralServerConfig,
  validateCentralServerCredentials,
  type CentralConfigEnv,
  type CentralConnectedRuntimeConfig,
  type CentralCredentialConfig,
  type CentralSecretFileReader,
  type CentralServerAuthMode,
  type CentralServerConfig,
  type LoadCentralConnectedRuntimeConfigOptions,
  type LoadCentralServerConfigOptions,
} from "./config/index.js";

export {
  createInMemoryCentralPorts,
  type InMemoryCentralPortsOptions,
} from "./controlPlane/inMemoryCentralPorts.js";

export {
  CENTRAL_SCHEMA_MIGRATIONS,
  CENTRAL_SCHEMA_VERSION,
  CentralMigrationError,
  CentralSqliteDatabase,
  CentralSqliteOpenError,
  createSqliteCentralCatalogRepository,
  createSqliteCentralTelemetryPort,
  createSqliteModelPolicyRepository,
  initializeCentralSqliteDatabase,
  openCentralSqliteDatabase,
  readCentralSchemaMigrations,
  runCentralSchemaMigrations,
  type CentralMigrationFailureStage,
  type CentralMigrationResult,
  type CentralSchemaMigration,
  type CentralSchemaMigrationRecord,
  type CentralSqliteBindParameter,
  type CentralSqliteBindValue,
  type CentralSqliteDriver,
  type CentralSqliteRunResult,
  type CentralSqliteStatement,
  type CentralTelemetryRetentionScheduler,
  type InitializedCentralSqliteDatabase,
  type InitializeCentralSqliteDatabaseOptions,
  type OpenCentralSqliteDatabaseOptions,
  type RunCentralSchemaMigrationsOptions,
  type SqliteCentralCatalogRepositoryOptions,
  type SqliteCentralTelemetryPort,
  type SqliteCentralTelemetryPortOptions,
  type SqliteModelPolicyRepositoryOptions,
} from "./persistence/index.js";

export {
  createInMemoryCentralCatalogRepository,
  hashCentralContent,
  type CentralCatalogRepository,
  type InMemoryCentralCatalogRepositoryOptions,
  CatalogConflictError,
  CatalogNotFoundError,
  CatalogVersionMismatchError,
  CentralCatalogWriteError,
} from "./controlPlane/centralCatalogRepository.js";

export {
  CentralModelPolicyWriteError,
  ModelPolicyConflictError,
  ModelPolicyNotFoundError,
  ModelPolicyVersionMismatchError,
  type CentralModelPolicyRepository,
} from "./controlPlane/centralModelPolicyRepository.js";

export {
  createInMemoryModelPolicyRepository,
  type InMemoryModelPolicyRepositoryOptions,
} from "./controlPlane/inMemoryModelPolicyRepository.js";

export {
  CENTRAL_SERVICE_ID,
  CENTRAL_CONTROL_PLANE_SCOPE,
  CENTRAL_IN_MEMORY_EVENT_CAP,
  nowIso,
} from "./controlPlane/shared.js";

export {
  handleMateriaCentralRequest,
  type MateriaCentralRouteDeps,
} from "./server/routes.js";

export {
  handleCentralAdminRoute,
  type CentralAdminRouteDeps,
} from "./server/admin.js";

export {
  CENTRAL_BUILD_SCHEMA_VERSION,
  CENTRAL_BUILD_VERSION,
} from "./server/buildMetadata.js";

export {
  handleCentralCatalogRoute,
  type CentralCatalogRouteDeps,
} from "./server/catalog.js";

export {
  handleCentralModelPolicyRoute,
  type CentralModelPolicyRouteDeps,
} from "./server/modelPolicy.js";

export {
  handleCentralModelCatalogRoute,
  type CentralModelCatalogRouteDeps,
} from "./server/modelCatalog.js";

export {
  handleCentralTelemetryRoute,
  type CentralTelemetryRouteDeps,
} from "./server/telemetry.js";

export {
  normalizeEnrichedEvent,
  normalizeTelemetryIngestBody,
  type NormalizedTelemetryIngest,
  type NormalizeTelemetryIngestOptions,
  type NormalizeTelemetryIngestResult,
} from "./controlPlane/telemetryIngest.js";

export {
  sendJson,
  readJsonBody,
  isPlainObject,
  errorMessage,
} from "./server/http.js";

// Central auth + RBAC (dev-token adapter + role registry + route guard).
export {
  BEARER_SCHEME,
  readBearerToken,
  type AuthAdapter,
  type AuthFailureReason,
  type AuthRequest,
  type AuthRequestHeaders,
  type AuthResolution,
  DEFAULT_CENTRAL_ROLE_REGISTRY,
  DEFAULT_CENTRAL_ROLES,
  createRoleRegistry,
  type RoleRegistry,
  DEFAULT_DEV_TOKEN_ADMIN,
  DEFAULT_DEV_TOKEN_READER,
  DEFAULT_DEV_TOKEN_SINK,
  DEFAULT_DEV_TOKEN_TENANT_ID,
  DEV_TOKEN_METHOD_KIND,
  createDevTokenAuthAdapter,
  defaultDevTokenPrincipals,
  defaultDevTokensReferenceDefaultRoles,
  type DevTokenAuthAdapterOptions,
  type DevTokenPrincipal,
  type DevTokenPrincipalConfig,
  FORBIDDEN_ERROR,
  UNAUTHORIZED_ERROR,
  checkPermission,
  requirePermission,
  sendForbidden,
  sendUnauthorized,
  type CentralAuth,
  type CentralAuthOptions,
  type CentralAuthPrincipalSummary,
  type RequirePermissionInput,
  type RequirePermissionResult,
  createDefaultCentralAuth,
} from "./auth/index.js";
