import { handleActiveLoadoutRoute } from './activeLoadout.js';
import { handleGetConfigRoute, handlePostConfigRoute } from './config.js';
import { handleDefaultLoadoutRoute } from './defaultLoadout.js';
import { handleHealthRoute } from './health.js';
import { sendJson } from './http.js';
import { handleBackendModeRoute, type BackendModeOptions } from './mode.js';
import { CATALOG_PROMOTION_PATH_PREFIX, handleCatalogPromotionRoute } from './catalogPromotion.js';
import { buildMateriaModelCatalog } from './modelCatalog.js';
import { handleMonitorEventsRoute, handleMonitorSnapshotRoute } from './monitor.js';
import { handleProfileRoleGenerationRoute } from './profileRoleGeneration.js';
import { handleQuestDefaultLoadoutRoute } from './questDefaultLoadout.js';
import { handleQuestRoute } from './quests.js';
import { handleRoleGenerationRoute } from './roleGeneration.js';
import { serveStatic } from './static.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { MateriaSetActiveLoadoutCallback } from './activeLoadout.js';
import type { MateriaPromoteCatalogCallback } from './catalogPromotion.js';
import type { MateriaConfigPatch, MateriaSaveTarget } from './config.js';
import type { MateriaSetDefaultLoadoutCallback } from './defaultLoadout.js';
import type { MateriaModelCatalogSource } from './modelCatalog.js';
import type { MateriaGetRoleGenerationPreferenceCallback, MateriaSetRoleGenerationPreferenceCallback } from './profileRoleGeneration.js';
import type { MateriaSetQuestDefaultLoadoutCallback } from './questDefaultLoadout.js';
import type { MateriaAddQuestResult, MateriaQuestBoardSource, MateriaAddQuestInput, MateriaDeleteQuestInput, MateriaDeleteQuestResult, MateriaQuestControlInput, MateriaQuestControlResult, MateriaReorderQuestInput, MateriaReorderQuestResult, MateriaRequeueQuestInput, MateriaRequeueQuestResult, MateriaUpdateQuestInput, MateriaUpdateQuestResult } from './quests.js';
import type { MateriaRolePromptGenerationRequest, MateriaRolePromptGenerationResult } from './roleGeneration.js';
import type { MateriaWebUiSessionSnapshot } from './session.js';

export interface MateriaWebUiRouteDeps {
  /**
   * Backend mode discovery options surfaced via `GET /api/backend-mode` so the
   * frontend can distinguish same-origin local session APIs from a configured
   * central control plane (docs/enterprise-control-plane.md §8).
   */
  mode?: BackendModeOptions;
  staticDir: string;
  session?: {
    key: string;
    getSnapshot: () => MateriaWebUiSessionSnapshot | Promise<MateriaWebUiSessionSnapshot>;
    getConfig?: () => Promise<unknown>;
    saveConfig?: (patch: MateriaConfigPatch, target: MateriaSaveTarget) => Promise<string>;
    /** Explicit central-to-local copy/update/replace action for this local session. */
    promoteCatalog?: MateriaPromoteCatalogCallback;
    setActiveLoadout?: MateriaSetActiveLoadoutCallback;
    setDefaultLoadout?: MateriaSetDefaultLoadoutCallback;
    setQuestDefaultLoadout?: MateriaSetQuestDefaultLoadoutCallback;
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

// Ordered dispatcher for the WebUI HTTP surface. Keep startsWith checks and
// route order stable for compatibility; individual modules own validation,
// response envelopes, and route-specific dependencies.
export async function handleMateriaWebUiRequest(req: IncomingMessage, res: ServerResponse, deps: MateriaWebUiRouteDeps) {
  if (req.url?.startsWith('/api/health')) {
    handleHealthRoute(res, { sessionKey: deps.session?.key });
    return;
  }

  // Backend mode discovery (docs/enterprise-control-plane.md §8). The prefix
  // is `/api/backend-mode` (not `/api/mode`) so it cannot collide with
  // `/api/models` under the dispatcher's `startsWith` matching.
  if (req.url?.startsWith('/api/backend-mode')) {
    if (req.method && req.method !== 'GET') {
      sendJson(res, 405, { ok: false, error: 'Use GET to read backend mode discovery.' });
      return;
    }
    handleBackendModeRoute(res, deps.mode ?? {});
    return;
  }

  if (req.url?.startsWith('/api/models')) {
    if (req.method && req.method !== 'GET') {
      sendJson(res, 405, { ok: false, error: 'Use GET to read available models.' });
      return;
    }
    sendJson(res, 200, await buildMateriaModelCatalog(deps.session?.modelCatalog));
    return;
  }

  if (req.url?.startsWith('/api/monitor/events')) {
    await handleMonitorEventsRoute(req, res, { getSnapshot: deps.session?.getSnapshot });
    return;
  }

  if (req.url?.startsWith('/api/session') || req.url?.startsWith('/api/monitor')) {
    await handleMonitorSnapshotRoute(res, { getSnapshot: deps.session?.getSnapshot });
    return;
  }

  if (req.url?.startsWith('/api/config') && req.method === 'GET') {
    await handleGetConfigRoute(res, { getConfig: deps.session?.getConfig });
    return;
  }

  if (req.url?.startsWith('/api/config') && req.method === 'POST') {
    await handlePostConfigRoute(req, res, { saveConfig: deps.session?.saveConfig });
    return;
  }

  // Local-session-only central-to-local writes. The standalone central server
  // has a separate dispatcher and never composes this route or a local store.
  if (req.url?.startsWith(CATALOG_PROMOTION_PATH_PREFIX)) {
    await handleCatalogPromotionRoute(req, res, {
      promoteCatalog: deps.session?.promoteCatalog,
      getConfig: deps.session?.getConfig,
    });
    return;
  }

  if (req.url?.startsWith('/api/loadout/active')) {
    await handleActiveLoadoutRoute(req, res, { setActiveLoadout: deps.session?.setActiveLoadout });
    return;
  }

  if (req.url?.startsWith('/api/loadout/default')) {
    await handleDefaultLoadoutRoute(req, res, { setDefaultLoadout: deps.session?.setDefaultLoadout });
    return;
  }

  if (req.url?.startsWith('/api/loadout/quest-default-loadout')) {
    await handleQuestDefaultLoadoutRoute(req, res, { setQuestDefaultLoadout: deps.session?.setQuestDefaultLoadout });
    return;
  }

  if (req.url?.startsWith('/api/quests')) {
    await handleQuestRoute(req, res, { getQuestBoard: deps.session?.getQuestBoard, runQuest: deps.session?.runQuest, runQuestOnce: deps.session?.runQuestOnce, stopQuestRunner: deps.session?.stopQuestRunner, addQuest: deps.session?.addQuest, updateQuest: deps.session?.updateQuest, reorderQuest: deps.session?.reorderQuest, requeueQuest: deps.session?.requeueQuest, deleteQuest: deps.session?.deleteQuest });
    return;
  }

  if (req.url?.startsWith('/api/profile/role-generation')) {
    await handleProfileRoleGenerationRoute(req, res, {
      getRoleGenerationPreference: deps.session?.getRoleGenerationPreference,
      setRoleGenerationPreference: deps.session?.setRoleGenerationPreference,
    });
    return;
  }

  if (req.url?.startsWith('/api/generate/materia-role')) {
    await handleRoleGenerationRoute(req, res, { generateMateriaRole: deps.session?.generateMateriaRole });
    return;
  }

  serveStatic(req, res, deps.staticDir);
}
