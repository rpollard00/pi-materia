import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleMateriaWebUiRequest } from './routes.js';
import type { MateriaSetActiveLoadoutCallback } from './activeLoadout.js';
import type { MateriaConfigPatch, MateriaSaveTarget } from './config.js';
import type { MateriaSetDefaultLoadoutCallback } from './defaultLoadout.js';
import type { MateriaModelCatalogSource } from './modelCatalog.js';
import type { MateriaGetRoleGenerationPreferenceCallback, MateriaSetRoleGenerationPreferenceCallback } from './profileRoleGeneration.js';
import type { MateriaSetQuestDefaultLoadoutCallback } from './questDefaultLoadout.js';
import type { MateriaAddQuestInput, MateriaAddQuestResult, MateriaDeleteQuestInput, MateriaDeleteQuestResult, MateriaQuestBoardSource, MateriaQuestControlInput, MateriaQuestControlResult, MateriaReorderQuestInput, MateriaReorderQuestResult, MateriaRequeueQuestInput, MateriaRequeueQuestResult, MateriaUpdateQuestInput, MateriaUpdateQuestResult } from './quests.js';
import type { MateriaRolePromptGenerationRequest, MateriaRolePromptGenerationResult } from './roleGeneration.js';
import type { MateriaWebUiSessionSnapshot } from './session.js';
import type { BackendModeOptions } from './mode.js';

// Compatibility facade: consumers and tests import public WebUI server helpers
// from this entry point while route/service implementations live in focused
// backend modules next to it.
export { buildMateriaModelCatalog } from './modelCatalog.js';
export { DEFAULT_RUNTIME_EVENT_LIMIT, RUNTIME_EVENTS_RELATIVE_PATH, readRuntimeEvents } from './runtimeEventReader.js';
export type { RuntimeEventReaderOptions } from './runtimeEventReader.js';
export type { MateriaConfigPatch, MateriaSaveTarget } from './config.js';
export type { MateriaModelCatalogModel, MateriaModelCatalogResponse, MateriaModelCatalogSource } from './modelCatalog.js';
export type { MateriaGetRoleGenerationPreferenceCallback, MateriaRoleGenerationPreference, MateriaSetRoleGenerationPreferenceCallback } from './profileRoleGeneration.js';
export type { MateriaAddQuestInput, MateriaAddQuestResponse, MateriaAddQuestResult, MateriaDeleteQuestInput, MateriaDeleteQuestResponse, MateriaDeleteQuestResult, MateriaQuestBoardResponse, MateriaQuestBoardSource, MateriaQuestControlAction, MateriaQuestControlInput, MateriaQuestControlResponse, MateriaQuestControlResult, MateriaQuestCounts, MateriaQuestSummary, MateriaQuestNoStartReason, MateriaQuestReorderPlacement, MateriaReorderQuestInput, MateriaReorderQuestResult, MateriaRequeueQuestInput, MateriaRequeueQuestResult, MateriaUpdateQuestInput, MateriaUpdateQuestResponse, MateriaUpdateQuestResult } from './quests.js';
export type { MateriaGeneratorConfig, MateriaRolePromptGenerationRequest, MateriaRolePromptGenerationResult } from './roleGeneration.js';
export type { MateriaSetActiveLoadoutCallback, MateriaSetActiveLoadoutFailureCode, MateriaSetActiveLoadoutResult } from './activeLoadout.js';
export type { MateriaSetDefaultLoadoutCallback, MateriaSetDefaultLoadoutFailureCode, MateriaSetDefaultLoadoutResult } from './defaultLoadout.js';
export type { MateriaSetQuestDefaultLoadoutCallback, MateriaSetQuestDefaultLoadoutFailureCode, MateriaSetQuestDefaultLoadoutResult } from './questDefaultLoadout.js';
export type { MateriaMonitorArtifactEntry, MateriaMonitorEventEntry, MateriaToolRegistrySnapshot, MateriaWebUiSessionSnapshot } from './session.js';
export {
  WEBUI_BACKEND_SERVICE,
  handleBackendModeRoute,
  isCentralSameOrigin,
  resolveBackendMode,
  resolveCentralApiBaseUrl,
  resolveCentralOrigin,
  type BackendModeEndpointDescriptor,
  type BackendModeOptions,
  type BackendModeResponse,
  type BackendModeRouteDeps,
} from './mode.js';

export interface MateriaWebUiServerOptions {
  host?: string;
  port?: number;
  staticDir?: string;
  /**
   * Backend mode discovery options surfaced via `GET /api/backend-mode`
   * (docs/enterprise-control-plane.md §8). When omitted the server reports
   * `local-only` mode with no central control plane configured.
   */
  mode?: BackendModeOptions;
  session?: {
    key: string;
    cwd: string;
    sessionFile: string;
    sessionId: string;
    startedAt: number;
    getSnapshot: () => MateriaWebUiSessionSnapshot | Promise<MateriaWebUiSessionSnapshot>;
    getConfig?: () => Promise<unknown>;
    saveConfig?: (patch: MateriaConfigPatch, target: MateriaSaveTarget) => Promise<string>;
    /** Authoritative backend/session callback for active-loadout changes from the WebUI. */
    setActiveLoadout?: MateriaSetActiveLoadoutCallback;
    /** User preference callback for the durable default loadout. */
    setDefaultLoadout?: MateriaSetDefaultLoadoutCallback;
    /** User preference callback for autonomous quest runner default loadout. */
    setQuestDefaultLoadout?: MateriaSetQuestDefaultLoadoutCallback;
    /** User profile preference for isolated role-generation model selection. */
    getRoleGenerationPreference?: MateriaGetRoleGenerationPreferenceCallback;
    setRoleGenerationPreference?: MateriaSetRoleGenerationPreferenceCallback;
    getQuestBoard?: () => Promise<MateriaQuestBoardSource>;
    runQuest?: (input: MateriaQuestControlInput) => Promise<MateriaQuestControlResult>;
    runQuestOnce?: (input: MateriaQuestControlInput) => Promise<MateriaQuestControlResult>;
    stopQuestRunner?: () => Promise<MateriaQuestControlResult>;
    addQuest?: (input: MateriaAddQuestInput) => Promise<MateriaAddQuestResult>;
    updateQuest?: (input: MateriaUpdateQuestInput) => Promise<MateriaUpdateQuestResult>;
    reorderQuest?: (input: MateriaReorderQuestInput) => Promise<MateriaReorderQuestResult>;
    requeueQuest?: (input: MateriaRequeueQuestInput) => Promise<MateriaRequeueQuestResult>;
    deleteQuest?: (input: MateriaDeleteQuestInput) => Promise<MateriaDeleteQuestResult>;
    generateMateriaRole?: (request: MateriaRolePromptGenerationRequest) => Promise<MateriaRolePromptGenerationResult>;
    modelCatalog?: MateriaModelCatalogSource;
  };
}

const defaultStaticDir = resolve(fileURLToPath(new URL('../../../dist/webui/client', import.meta.url)));

export function createMateriaWebUiServer(options: MateriaWebUiServerOptions = {}) {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 0;
  const staticDir = resolve(options.staticDir ?? defaultStaticDir);

  const server = createServer(async (req, res) => {
    await handleMateriaWebUiRequest(req, res, { staticDir, session: options.session, ...(options.mode !== undefined ? { mode: options.mode } : {}) });
  });

  return { server, host, port, staticDir };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number.parseInt(process.env.MATERIA_WEBUI_PORT ?? '0', 10);
  const { server, host, staticDir } = createMateriaWebUiServer({ port: Number.isFinite(port) ? port : 0 });
  server.listen(port, host, () => {
    const address = server.address();
    const actualPort = typeof address === 'object' && address ? address.port : port;
    console.log(`Materia WebUI listening at http://${host}:${actualPort} (static: ${staticDir})`);
  });
}
