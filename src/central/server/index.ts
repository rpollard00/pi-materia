import { createServer } from "node:http";
import { createDefaultCentralAuth, type CentralAuth } from "../auth/index.js";
import { createInMemoryCentralPorts } from "../controlPlane/inMemoryCentralPorts.js";
import { CENTRAL_SERVICE_ID } from "../controlPlane/shared.js";
import { DEFAULT_CENTRAL_RETENTION_DAYS, loadCentralServerConfig } from "../config/index.js";
import {
  createSqliteCentralCatalogRepository,
  createSqliteCentralTelemetryPort,
  createSqliteModelPolicyRepository,
  initializeCentralSqliteDatabase,
  type CentralSqliteDatabase,
} from "../persistence/index.js";
import { applyCentralCorsHeaders, errorMessage, handleCentralCorsPreflight, sendJson } from "./http.js";
import { handleMateriaCentralRequest } from "./routes.js";
import type { ControlPlanePorts } from "../../application/controlPlane.js";

export { createInMemoryCentralPorts } from "../controlPlane/inMemoryCentralPorts.js";
export type { InMemoryCentralPortsOptions } from "../controlPlane/inMemoryCentralPorts.js";
export { CENTRAL_SERVICE_ID, CENTRAL_CONTROL_PLANE_SCOPE } from "../controlPlane/shared.js";
export { sendJson, readJsonBody, isPlainObject, errorMessage, applyCentralCorsHeaders, handleCentralCorsPreflight, CENTRAL_CORS_ALLOW_ORIGIN } from "./http.js";
export { handleCentralHealthRoute } from "./health.js";
export type { CentralHealthRouteDeps } from "./health.js";
export { handleCentralStatusRoute } from "./status.js";
export type { CentralStatusRouteDeps } from "./status.js";
export { handleCentralCatalogRoute } from "./catalog.js";
export type { CentralCatalogRouteDeps } from "./catalog.js";
export { handleCentralModelPolicyRoute } from "./modelPolicy.js";
export type { CentralModelPolicyRouteDeps } from "./modelPolicy.js";
export { handleCentralModelCatalogRoute } from "./modelCatalog.js";
export type { CentralModelCatalogRouteDeps } from "./modelCatalog.js";
export { handleCentralTelemetryRoute } from "./telemetry.js";
export type { CentralTelemetryRouteDeps } from "./telemetry.js";
export { handleMateriaCentralRequest } from "./routes.js";
export type { MateriaCentralRouteDeps } from "./routes.js";

export interface MateriaCentralServerOptions {
  host?: string;
  port?: number;
  /**
   * Control-plane ports backing the server. Explicit ports take the place of
   * database-backed composition. When neither ports nor a database is supplied,
   * the server retains its in-memory development/test fallback.
   */
  ports?: ControlPlanePorts;
  /**
   * Initialized central database used for durable catalog, model-policy, and
   * telemetry adapters when `ports` is omitted. The caller owns its lifecycle.
   */
  database?: CentralSqliteDatabase;
  /** Telemetry retention interval used with `database`. Defaults to 30 days. */
  retentionDays?: number;
  /**
   * Auth configuration for the route guards. Defaults to a dev-token adapter
   * with the documented development-only token set and the default central role
   * registry. Supply a custom {@link CentralAuth} (future OAuth/OIDC adapter +
   * custom roles) for non-local deployments (docs/enterprise-control-plane.md
   * §13).
   */
  auth?: CentralAuth;
  /** Human-readable label surfaced on health/status envelopes. */
  label?: string;
  /** Resolved CORS allow-origin value for this server instance. */
  corsOrigin?: string;
}

export interface MateriaCentralServer {
  /** The underlying Node HTTP server. */
  server: ReturnType<typeof createServer>;
  /** Resolved bind host. */
  host: string;
  /** Requested bind port (use `server.address()` for the actual bound port). */
  port: number;
  /** Control-plane ports backing the server. */
  ports: ControlPlanePorts;
  /** Resolved auth configuration used by route guards. */
  auth: CentralAuth;
}

/**
 * Create the central control-plane server.
 *
 * Separate from the local-session WebUI server (src/webui/server/index.ts):
 * startup does not open a local repository session, does not read
 * `.pi/pi-materia/quest-board.json`, and does not expose local-session routes.
 * Catalog, model-policy, and telemetry state use SQLite when an initialized
 * `database` is supplied. Tests and embedded callers may still inject ports
 * explicitly; the fallback remains in-memory for backwards compatibility.
 */
export function createMateriaCentralServer(options: MateriaCentralServerOptions = {}): MateriaCentralServer {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 0;
  const auth = options.auth ?? createDefaultCentralAuth();
  if (options.ports !== undefined && options.database !== undefined) {
    throw new TypeError("Materia central server accepts either explicit ports or a database, not both");
  }
  const ports = options.ports ?? createInMemoryCentralPorts({
    ...(options.label !== undefined ? { label: options.label } : {}),
    authMethods: [auth.methodKind],
    ...(options.database !== undefined
      ? {
          catalogRepository: createSqliteCentralCatalogRepository(options.database),
          policyRepository: createSqliteModelPolicyRepository(options.database),
          telemetryPort: createSqliteCentralTelemetryPort(options.database, {
            retentionDays: options.retentionDays ?? DEFAULT_CENTRAL_RETENTION_DAYS,
            ...(options.label !== undefined ? { label: options.label } : {}),
          }),
        }
      : {}),
  });

  const server = createServer(async (req, res) => {
    try {
      if (options.corsOrigin !== undefined) applyCentralCorsHeaders(res, options.corsOrigin);
      if (handleCentralCorsPreflight(req, res, options.corsOrigin)) return;
      await handleMateriaCentralRequest(req, res, { ports, auth, ...(options.label !== undefined ? { label: options.label } : {}) });
    } catch (error) {
      sendJson(res, 500, { ok: false, scope: "control-plane", service: CENTRAL_SERVICE_ID, error: errorMessage(error) });
    }
  });

  return { server, host, port, ports, auth };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = await loadCentralServerConfig();
  // Migrate before binding the HTTP socket so an incompatible or partially
  // writable database cannot produce a falsely ready central server.
  const initialized = await initializeCentralSqliteDatabase({ path: config.databasePath });
  const created = createMateriaCentralServer({
    host: config.host,
    port: config.port,
    corsOrigin: config.corsOrigin,
    database: initialized.database,
    retentionDays: config.retentionDays,
    ...(config.label !== undefined ? { label: config.label } : {}),
  });
  created.server.once("close", () => initialized.database.close());
  created.server.once("error", () => initialized.database.close());
  created.server.listen(created.port, created.host, () => {
    const address = created.server.address();
    const actualPort = typeof address === "object" && address ? address.port : created.port;
    const mode = created.ports.telemetry.mode().mode;
    console.log(
      `${CENTRAL_SERVICE_ID} (central control plane, mode=${mode}, schema=${initialized.migrationResult.currentVersion}) listening at http://${created.host}:${actualPort}`,
    );
  });
}
