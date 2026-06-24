/**
 * Central control-plane module.
 *
 * Hosts the central server and its in-memory control-plane adapters, separate
 * from the local session WebUI server (src/webui) and from the local
 * control-plane adapter (src/infrastructure/localControlPlane). The central
 * server never couples to a local repository session
 * (docs/enterprise-control-plane.md §3.3, §4, §16.4).
 */
export {
  createMateriaCentralServer,
  type MateriaCentralServer,
  type MateriaCentralServerOptions,
} from "./server/index.js";

export {
  createInMemoryCentralPorts,
  type InMemoryCentralPortsOptions,
} from "./controlPlane/inMemoryCentralPorts.js";

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
  sendJson,
  readJsonBody,
  isPlainObject,
  errorMessage,
} from "./server/http.js";
