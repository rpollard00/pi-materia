import { handleActiveLoadoutRoute } from './activeLoadout.js';
import { handleGetConfigRoute, handlePostConfigRoute } from './config.js';
import { handleDefaultLoadoutRoute } from './defaultLoadout.js';
import { handleHealthRoute } from './health.js';
import { sendJson } from './http.js';
import { handleBackendModeRoute } from './mode.js';
import { buildMateriaModelCatalog } from './modelCatalog.js';
import { handleMonitorEventsRoute, handleMonitorSnapshotRoute } from './monitor.js';
import { handleProfileRoleGenerationRoute } from './profileRoleGeneration.js';
import { handleQuestDefaultLoadoutRoute } from './questDefaultLoadout.js';
import { handleQuestRoute } from './quests.js';
import { handleRoleGenerationRoute } from './roleGeneration.js';
import { serveStatic } from './static.js';
// Ordered dispatcher for the WebUI HTTP surface. Keep startsWith checks and
// route order stable for compatibility; individual modules own validation,
// response envelopes, and route-specific dependencies.
export async function handleMateriaWebUiRequest(req, res, deps) {
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
