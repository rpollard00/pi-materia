import { errorMessage, isPlainObject, readJsonBody, sendJson } from './http.js';
export async function handleQuestRoute(req, res, deps) {
    const pathname = req.url ? new URL(req.url, 'http://localhost').pathname : '';
    if (pathname === '/api/quests/runonce') {
        await handleRunQuestOnceRoute(req, res, deps);
        return;
    }
    if (pathname === '/api/quests/run') {
        await handleRunQuestRoute(req, res, deps);
        return;
    }
    if (pathname === '/api/quests/stop') {
        await handleStopQuestRunnerRoute(req, res, deps);
        return;
    }
    if (req.url?.startsWith('/api/quests/requeue')) {
        await handleRequeueQuestRoute(req, res, deps);
        return;
    }
    if (req.url?.startsWith('/api/quests/reorder')) {
        await handleReorderQuestRoute(req, res, deps);
        return;
    }
    if (req.method === 'GET') {
        await handleGetQuestsRoute(res, deps);
        return;
    }
    if (req.method === 'POST') {
        await handlePostQuestRoute(req, res, deps);
        return;
    }
    if (req.method === 'PATCH') {
        await handlePatchQuestRoute(req, res, deps);
        return;
    }
    if (req.method === 'DELETE') {
        await handleDeleteQuestRoute(req, res, deps);
        return;
    }
    sendJson(res, 405, { ok: false, error: 'Use GET to read quests, POST to add a quest, PATCH /api/quests/:questId to edit a pending quest, DELETE /api/quests/:questId to remove a quest, or POST /api/quests/reorder to reorder quests.' });
}
export async function handleRunQuestRoute(req, res, deps) {
    await handleQuestControlRoute(req, res, deps.runQuest, 'run', 'Use POST to run quests.');
}
export async function handleRunQuestOnceRoute(req, res, deps) {
    await handleQuestControlRoute(req, res, deps.runQuestOnce, 'runonce', 'Use POST to run one quest.');
}
export async function handleStopQuestRunnerRoute(req, res, deps) {
    if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'Use POST to stop the quest runner.' });
        return;
    }
    if (!deps.stopQuestRunner) {
        sendJson(res, 503, { ok: false, error: 'Quest runner control API is unavailable for this server.' });
        return;
    }
    try {
        const body = await readJsonBody(req);
        if (!isPlainObject(body))
            throw new Error('Expected JSON object body.');
        if (Object.keys(body).length > 0)
            throw new Error('Stop does not accept a request body.');
        await sendQuestControlResult(res, deps.stopQuestRunner());
    }
    catch (error) {
        sendJson(res, 400, { ok: false, error: errorMessage(error) });
    }
}
async function handleQuestControlRoute(req, res, callback, action, methodError) {
    if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: methodError });
        return;
    }
    if (!callback) {
        sendJson(res, 503, { ok: false, error: 'Quest runner control API is unavailable for this server.' });
        return;
    }
    try {
        const body = await readJsonBody(req);
        if (!isPlainObject(body))
            throw new Error('Expected JSON object body.');
        const keys = Object.keys(body);
        if (keys.some((key) => key !== 'questId'))
            throw new Error('Only questId is accepted.');
        const questId = typeof body.questId === 'string' ? body.questId.trim() : undefined;
        if (body.questId !== undefined && !questId)
            throw new Error('questId must be a non-empty string.');
        await sendQuestControlResult(res, callback({ ...(questId ? { questId } : {}) }));
    }
    catch (error) {
        sendJson(res, 400, { ok: false, error: errorMessage(error) });
    }
}
async function sendQuestControlResult(res, pendingResult) {
    const result = await pendingResult;
    if (!result.ok) {
        sendJson(res, result.code === 'unavailable' ? 503 : 400, { ok: false, code: result.code, error: result.message });
        return;
    }
    sendJson(res, 200, mapQuestControlResponse(result));
}
export async function handleGetQuestsRoute(res, deps) {
    if (!deps.getQuestBoard) {
        sendJson(res, 503, { ok: false, error: 'Quest API is unavailable for this server.' });
        return;
    }
    try {
        const source = await deps.getQuestBoard();
        sendJson(res, 200, mapQuestBoardResponse(source));
    }
    catch (error) {
        sendJson(res, 500, { ok: false, error: errorMessage(error) });
    }
}
export async function handlePostQuestRoute(req, res, deps) {
    if (!deps.addQuest) {
        sendJson(res, 503, { ok: false, error: 'Quest add API is unavailable for this server.' });
        return;
    }
    try {
        const body = await readJsonBody(req);
        if (!isPlainObject(body))
            throw new Error('Expected JSON object body.');
        const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
        if (!prompt)
            throw new Error('Quest prompt is required.');
        const rawLoadoutOverride = typeof body.loadoutOverride === 'string' ? body.loadoutOverride.trim() : undefined;
        const result = await deps.addQuest({ prompt, ...(rawLoadoutOverride ? { loadoutOverride: rawLoadoutOverride } : {}) });
        if (!result.ok) {
            sendJson(res, result.code === 'unavailable' ? 503 : 400, { ok: false, code: result.code, error: result.message });
            return;
        }
        const board = mapQuestBoardResponse(result);
        sendJson(res, 200, { ok: true, quest: mapQuest(result.quest), board });
    }
    catch (error) {
        sendJson(res, 400, { ok: false, error: errorMessage(error) });
    }
}
export async function handleDeleteQuestRoute(req, res, deps) {
    if (!deps.deleteQuest) {
        sendJson(res, 503, { ok: false, error: 'Quest delete API is unavailable for this server.' });
        return;
    }
    try {
        const questId = questIdFromQuestUrl(req.url);
        if (!questId)
            throw new Error('Quest id is required.');
        const result = await deps.deleteQuest({ questId });
        if (!result.ok) {
            sendJson(res, result.code === 'unavailable' ? 503 : 400, { ok: false, code: result.code, error: result.message });
            return;
        }
        const board = mapQuestBoardResponse(result);
        sendJson(res, 200, { ok: true, quest: mapQuest(result.quest), board });
    }
    catch (error) {
        sendJson(res, 400, { ok: false, error: errorMessage(error) });
    }
}
export async function handlePatchQuestRoute(req, res, deps) {
    if (!deps.updateQuest) {
        sendJson(res, 503, { ok: false, error: 'Quest update API is unavailable for this server.' });
        return;
    }
    try {
        const questId = questIdFromQuestUrl(req.url);
        if (!questId)
            throw new Error('Quest id is required.');
        const body = await readJsonBody(req);
        if (!isPlainObject(body))
            throw new Error('Expected JSON object body.');
        const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
        if (!prompt)
            throw new Error('Quest prompt is required.');
        const rawLoadoutOverride = typeof body.loadoutOverride === 'string' ? body.loadoutOverride.trim() : undefined;
        const result = await deps.updateQuest({ questId, prompt, ...(rawLoadoutOverride ? { loadoutOverride: rawLoadoutOverride } : {}) });
        if (!result.ok) {
            sendJson(res, result.code === 'unavailable' ? 503 : 400, { ok: false, code: result.code, error: result.message });
            return;
        }
        const board = mapQuestBoardResponse(result);
        sendJson(res, 200, { ok: true, quest: mapQuest(result.quest), board });
    }
    catch (error) {
        sendJson(res, 400, { ok: false, error: errorMessage(error) });
    }
}
export async function handleRequeueQuestRoute(req, res, deps) {
    if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'Use POST to requeue quests.' });
        return;
    }
    if (!deps.requeueQuest) {
        sendJson(res, 503, { ok: false, error: 'Quest requeue API is unavailable for this server.' });
        return;
    }
    try {
        const body = await readJsonBody(req);
        if (!isPlainObject(body))
            throw new Error('Expected JSON object body.');
        const questId = typeof body.questId === 'string' ? body.questId.trim() : '';
        if (!questId)
            throw new Error('Quest id is required.');
        const result = await deps.requeueQuest({ questId });
        if (!result.ok) {
            sendJson(res, result.code === 'unavailable' ? 503 : 400, { ok: false, code: result.code, error: result.message });
            return;
        }
        sendJson(res, 200, mapQuestBoardResponse(result));
    }
    catch (error) {
        sendJson(res, 400, { ok: false, error: errorMessage(error) });
    }
}
export async function handleReorderQuestRoute(req, res, deps) {
    if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'Use POST to reorder quests.' });
        return;
    }
    if (!deps.reorderQuest) {
        sendJson(res, 503, { ok: false, error: 'Quest reorder API is unavailable for this server.' });
        return;
    }
    try {
        const body = await readJsonBody(req);
        if (!isPlainObject(body))
            throw new Error('Expected JSON object body.');
        const questId = typeof body.questId === 'string' ? body.questId.trim() : '';
        if (!questId)
            throw new Error('Quest id is required.');
        const placement = typeof body.placement === 'string' ? body.placement.trim() : '';
        if (!isQuestReorderPlacement(placement))
            throw new Error('Quest placement must be first, before, or after.');
        const rawTargetId = typeof body.targetId === 'string' ? body.targetId.trim() : undefined;
        const result = await deps.reorderQuest({ questId, placement, ...(rawTargetId ? { targetId: rawTargetId } : {}) });
        if (!result.ok) {
            sendJson(res, result.code === 'unavailable' ? 503 : 400, { ok: false, code: result.code, error: result.message });
            return;
        }
        sendJson(res, 200, mapQuestBoardResponse(result));
    }
    catch (error) {
        sendJson(res, 400, { ok: false, error: errorMessage(error) });
    }
}
function isQuestReorderPlacement(value) {
    return value === 'first' || value === 'before' || value === 'after';
}
function questIdFromQuestUrl(url) {
    if (!url)
        return '';
    const pathname = new URL(url, 'http://localhost').pathname;
    const match = /^\/api\/quests\/([^/]+)$/.exec(pathname);
    return match?.[1] ? decodeURIComponent(match[1]).trim() : '';
}
export function mapQuestControlResponse(result) {
    return {
        ok: true,
        action: result.action,
        board: mapQuestBoardResponse(result),
        message: result.message,
        ...(result.reason ? { reason: result.reason } : {}),
        ...(result.started ? {
            started: {
                quest: mapQuest(result.started.quest),
                castId: result.started.castId,
                ...(result.started.currentSocketId ? { currentSocketId: result.started.currentSocketId } : {}),
                ...(result.started.artifactRoot ? { artifactRoot: result.started.artifactRoot } : {}),
                ...(result.started.runDir ? { runDir: result.started.runDir } : {}),
            },
        } : {}),
    };
}
export function mapQuestBoardResponse(source) {
    const { board } = source;
    const runningQuest = board.quests.find((quest) => quest.status === 'running');
    const activeQuest = board.runner.activeQuestId ? board.quests.find((quest) => quest.id === board.runner.activeQuestId) ?? runningQuest : runningQuest;
    const pendingQuests = board.quests.filter((quest) => quest.status === 'pending').map(mapQuest);
    const completedQuests = sortCompletedQuestsByCompletionTime(board.quests).map(mapQuest);
    const failedQuests = board.quests.filter((quest) => quest.status === 'failed' || quest.status === 'blocked').map(mapQuest);
    return {
        ok: true,
        boardPath: source.boardPath,
        runner: { ...board.runner },
        counts: countQuests(board.quests),
        ...(activeQuest ? { activeQuest: mapQuest(activeQuest) } : {}),
        ...(runningQuest ? { runningQuest: mapQuest(runningQuest) } : {}),
        pendingQuests,
        completedQuests,
        failedQuests,
        quests: board.quests.map(mapQuest),
        status: {
            statuses: ['pending', 'running', 'succeeded', 'failed', 'blocked'],
            ...(activeQuest ? { activeQuestId: activeQuest.id } : {}),
            updatedAt: board.updatedAt,
            generatedAt: new Date().toISOString(),
        },
    };
}
function sortCompletedQuestsByCompletionTime(quests) {
    return quests
        .map((quest, index) => ({ quest, index, completedAt: completionTimeMs(quest) }))
        .filter(({ quest }) => quest.status === 'succeeded')
        .sort((left, right) => right.completedAt - left.completedAt || left.index - right.index)
        .map(({ quest }) => quest);
}
function completionTimeMs(quest) {
    return validTimeMs(quest.lastResult?.finishedAt) ?? validTimeMs(quest.updatedAt) ?? Number.NEGATIVE_INFINITY;
}
function validTimeMs(value) {
    if (!value)
        return undefined;
    const time = Date.parse(value);
    return Number.isFinite(time) ? time : undefined;
}
export function mapQuest(quest) {
    return {
        id: quest.id,
        title: quest.title,
        prompt: quest.prompt,
        promptPreview: preview(quest.prompt),
        status: quest.status,
        attempts: quest.attempts,
        ...(quest.loadoutOverride ? { loadoutOverride: quest.loadoutOverride } : {}),
        createdAt: quest.createdAt,
        updatedAt: quest.updatedAt,
        ...(quest.currentCastId ? { currentCastId: quest.currentCastId } : {}),
        ...(quest.lastCastId ? { lastCastId: quest.lastCastId } : {}),
        ...(quest.lastResult ? { lastResult: mapRunResult(quest.lastResult) } : {}),
        ...(quest.lastError ? { lastError: mapRunError(quest.lastError) } : {}),
    };
}
function countQuests(quests) {
    const counts = { total: quests.length, pending: 0, running: 0, succeeded: 0, failed: 0, blocked: 0, completed: 0, terminal: 0 };
    for (const quest of quests)
        counts[quest.status] += 1;
    counts.completed = counts.succeeded;
    counts.terminal = counts.succeeded + counts.failed + counts.blocked;
    return counts;
}
function mapRunResult(result) {
    return {
        status: result.status,
        castId: result.castId,
        finishedAt: result.finishedAt,
        ...(result.message ? { message: result.message } : {}),
        ...(result.error ? { error: result.error } : {}),
        ...(result.artifactDirectory ? { artifactDirectory: result.artifactDirectory } : {}),
        ...(result.runDirectory ? { runDirectory: result.runDirectory } : {}),
        ...(result.requestedLoadoutOverride ? { requestedLoadoutOverride: result.requestedLoadoutOverride } : {}),
        ...(result.effectiveLoadoutId ? { effectiveLoadoutId: result.effectiveLoadoutId } : {}),
        ...(result.effectiveLoadoutName ? { effectiveLoadoutName: result.effectiveLoadoutName } : {}),
        ...(result.effectiveLoadoutSource ? { effectiveLoadoutSource: result.effectiveLoadoutSource } : {}),
    };
}
function mapRunError(error) {
    return {
        message: error.message,
        occurredAt: error.occurredAt,
        ...(error.castId ? { castId: error.castId } : {}),
        ...(error.code ? { code: error.code } : {}),
    };
}
function preview(text) {
    const normalized = text.replace(/\s+/g, ' ').trim();
    return normalized.length > 180 ? `${normalized.slice(0, 177)}…` : normalized;
}
