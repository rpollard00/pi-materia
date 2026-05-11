import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@mariozechner/pi-coding-agent";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { appendEvent, safePathSegment, safeTimestamp } from "./artifacts.js";
import { resolveProactiveCompactionThreshold } from "./compaction.js";
import { resolveArtifactRoot } from "./config.js";
import { getEffectivePipelineConfig, loopIteratorForSocket } from "./pipeline.js";
import { parseJson } from "./json.js";
import { applyGenericHandoffEnvelope } from "./application/handoff.js";
import { buildMultiTurnFinalizationPrompt, buildSocketPrompt, buildSyntheticCastContext, isActiveMultiTurnSocket, isPausedMultiTurnRefinement, materiaPrompt, multiTurnRefinementGuidance, renderTemplate } from "./application/promptAssembly.js";
export { activeMateriaSystemPrompt, buildIsolatedMateriaContext } from "./application/promptAssembly.js";
import { applyAdvance, applyAssignments, currentItem, evaluateCondition, getPath, resolveValue, selectNextTarget, setCurrentItem, setPath } from "./application/workflowTransitions.js";
import { stringifyDeterministicHandoffOutput } from "./handoffContract.js";
import { validateHandoffJsonOutput } from "./handoffValidation.js";
import { applyMateriaModelSettings } from "./modelSettings.js";
import { formatMateriaCastContent, formatMateriaNotificationDisplay } from "./notificationFormatting.js";
import type { AppliedMateriaModelSettings } from "./modelSettings.js";
import type { LoadedConfig, MateriaAgentConfig, MateriaCastState, MateriaManifest, MateriaManifestEntry, MateriaRecoveryAllowance, PiMateriaConfig, ResolvedMateriaAgentSocket, ResolvedMateriaSocket, ResolvedMateriaPipeline, MateriaModelSelection } from "./types.js";
import { formatUsage, showUsageSummary, updateWidget } from "./ui.js";
import { addUsage, assertBudget, createRunState, extractMessageModelInfo, extractUsage, recordUsageModelSelection, writeUsage } from "./usage.js";
import { executeBuiltInUtility, hasBuiltInUtility, type BuiltInUtilityInput } from "./utilityRegistry.js";

const STATE_ENTRY = "pi-materia-cast-state";
const MANIFEST_FILE = "manifest.json";
const DEFAULT_MAX_SOCKET_VISITS = 25;
const DEFAULT_UTILITY_TIMEOUT_MS = 30_000;
const MAX_UTILITY_OUTPUT_BYTES = 1024 * 1024;
const MAX_UTILITY_ERROR_SUMMARY_LENGTH = 800;
const MAX_METADATA_ITEM_LABEL_LENGTH = 80;
const DEFAULT_MAX_SAME_SOCKET_RECOVERY_ATTEMPTS = 1;

export { defaultProactiveCompactionThresholdPercent } from "./compaction.js";

export async function startNativeCast(pi: ExtensionAPI, ctx: ExtensionContext, loaded: LoadedConfig, pipeline: ResolvedMateriaPipeline, request: string): Promise<void> {
  const config = loaded.config;
  const artifactRoot = resolveArtifactRoot(ctx.cwd, config.artifactDir);
  const castId = safeTimestamp();
  const runDir = path.join(artifactRoot, castId);
  await mkdir(path.join(runDir, "sockets"), { recursive: true });
  await mkdir(path.join(runDir, "nodes"), { recursive: true }); // Legacy artifact path kept for saved tooling compatibility.
  await mkdir(path.join(runDir, "contexts"), { recursive: true });
  await writeFile(path.join(runDir, "config.resolved.json"), JSON.stringify(config, null, 2));

  const effectivePipeline = getEffectivePipelineConfig(config);
  const runState = createRunState(castId, runDir, ctx.model, effectivePipeline.loadoutName);
  runState.currentNode = pipeline.entry.id;
  runState.currentMateria = socketMateriaName(pipeline.entry);
  runState.lastMessage = pipeline.entry.id;
  await writeUsage(runState);
  await appendEvent(runState, "cast_start", { request, configSource: loaded.source, artifactRoot, pipeline: effectivePipeline.pipeline, loadout: effectivePipeline.loadoutName, nativeSession: true, isolatedMateriaContext: true });
  await writeManifest(runDir, { castId, request, configSource: loaded.source, sessionFile: ctx.sessionManager.getSessionFile(), entries: [] });

  const state: MateriaCastState = {
    version: 1,
    active: true,
    castId,
    request,
    configSource: loaded.source,
    configHash: hashConfig(config),
    cwd: ctx.cwd,
    runDir,
    artifactRoot,
    phase: pipeline.entry.id,
    currentNode: pipeline.entry.id,
    currentMateria: socketMateriaName(pipeline.entry),
    awaitingResponse: true,
    nodeState: "awaiting_agent_response",
    startedAt: Date.now(),
    updatedAt: Date.now(),
    data: {},
    cursors: {},
    visits: {},
    multiTurnRefinements: {},
    taskAttempts: {},
    edgeTraversals: {},
    runState,
    pipeline,
  };

  pi.setSessionName(`materia: ${request.slice(0, 60)}`);
  saveCastState(pi, state);
  updateWidget(ctx, state, { replaceOwner: true });
  ctx.ui.notify(`pi-materia cast started. Artifacts: ${runDir}`, "info");
  await startSocket(pi, ctx, state, pipeline.entry);
}

export async function continueNativeCast(pi: ExtensionAPI, ctx: ExtensionContext, state: MateriaCastState): Promise<void> {
  if (!state.active) throw new Error("No active pi-materia cast to continue.");
  if (state.awaitingResponse) throw new Error("Materia is already awaiting a Pi agent response.");

  if (currentSocketState(state) === "awaiting_user_refinement") {
    if (!isPausedMultiTurnRefinement(state)) {
      throw new Error("Materia is awaiting user refinement, but the current socket's resolved materia is not multi-turn.");
    }
    await startMultiTurnFinalizationTurn(pi, ctx, state);
    return;
  }

  await startSocket(pi, ctx, state, currentSocketOrThrow(state));
}

export function loadCastStateById(ctx: ExtensionContext, castId: string): MateriaCastState | undefined {
  const requested = castId.trim();
  if (!requested) return undefined;
  return listLatestCastStates(ctx).find((state) => state.castId === requested);
}

export function listLatestCastStates(ctx: ExtensionContext): MateriaCastState[] {
  const entries = ctx.sessionManager.getBranch();
  const seenCastIds = new Set<string>();
  const states: MateriaCastState[] = [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== "custom" || entry.customType !== STATE_ENTRY || !entry.data) continue;
    const state = entry.data as MateriaCastState;
    if (seenCastIds.has(state.castId)) continue;
    seenCastIds.add(state.castId);
    states.push(state);
  }
  return states;
}

export function listResumableCastStates(ctx: ExtensionContext): MateriaCastState[] {
  return listLatestCastStates(ctx).filter((state) => !state.active && state.phase !== "complete" && currentSocketState(state) !== "complete" && (state.phase === "failed" || currentSocketState(state) === "failed"));
}

export function listRevivableCastStates(ctx: ExtensionContext): MateriaCastState[] {
  return listResumableCastStates(ctx).filter(isRevivableCastState);
}

export async function reviveNativeCast(pi: ExtensionAPI, ctx: ExtensionContext, castId: string): Promise<MateriaCastState> {
  const state = loadCastStateById(ctx, castId);
  if (!state) throw new Error(`Unknown pi-materia cast id "${castId}" in this session.`);
  assertNoActiveNativeCast(ctx, state, "reviving");
  const result = extendSameSocketRecoveryAllowanceForRevive(state);
  await appendEvent(state.runState, "cast_revive", {
    castId: state.castId,
    exhaustedRecoveryKey: result.key,
    recoveryContext: {
      key: result.key,
      node: state.recoveryExhaustion?.node ?? currentSocketId(state),
      socket: state.recoveryExhaustion?.node ?? currentSocketId(state),
      mode: state.recoveryExhaustion?.mode,
      itemKey: state.currentItemKey,
    },
    priorEffectiveMaxAttempts: result.priorEffectiveMaxAttempts,
    increment: result.increment,
    newEffectiveMaxAttempts: result.newEffectiveMaxAttempts,
    reviveCount: result.reviveCount,
  });
  saveCastState(pi, state);
  return resumeValidatedNativeCast(pi, ctx, state);
}

export async function resumeNativeCast(pi: ExtensionAPI, ctx: ExtensionContext, castId: string): Promise<MateriaCastState> {
  const state = loadCastStateById(ctx, castId);
  if (!state) throw new Error(`Unknown pi-materia cast id "${castId}" in this session.`);
  assertNoActiveNativeCast(ctx, state, "recasting");
  assertRecastableNativeCast(state);
  return resumeValidatedNativeCast(pi, ctx, state);
}

function assertNoActiveNativeCast(ctx: ExtensionContext, state: MateriaCastState, action: "recasting" | "reviving"): void {
  const active = loadActiveCastState(ctx);
  if (active?.active) {
    if (active.castId === state.castId) throw new Error(`pi-materia cast ${state.castId} is already running.`);
    throw new Error(`A pi-materia cast is already active (${active.castId}). Abort it before ${action} ${state.castId}.`);
  }
}

function assertRecastableNativeCast(state: MateriaCastState): void {
  if (state.active) throw new Error(`pi-materia cast ${state.castId} is already running.`);
  if (state.phase === "complete" || currentSocketState(state) === "complete") throw new Error(`pi-materia cast ${state.castId} is complete and cannot be recast.`);
  if (state.phase !== "failed" && currentSocketState(state) !== "failed") throw new Error(`pi-materia cast ${state.castId} is not failed or aborted (phase: ${state.phase}, socket state: ${currentSocketState(state) ?? "unknown"}).`);
}

async function resumeValidatedNativeCast(pi: ExtensionAPI, ctx: ExtensionContext, state: MateriaCastState): Promise<MateriaCastState> {
  const socket = currentSocketOrThrow(state);
  const previousFailure = state.failedReason;

  state.recoveryExhaustion = undefined;
  state.active = true;
  state.phase = socket.id;
  setCurrentSocketId(state, socket.id);
  state.currentMateria = socketMateriaName(socket);
  state.awaitingResponse = isAgentResolvedSocket(socket);
  setCurrentSocketState(state, isAgentResolvedSocket(socket) ? "awaiting_agent_response" : "running_utility");
  state.failedReason = undefined;
  state.runState.endedAt = undefined;
  state.runState.loadoutName ||= await resolvePersistedCastLoadoutName(state);
  state.runState.currentNode = socket.id;
  state.runState.currentMateria = socketMateriaName(socket);
  state.runState.lastMessage = `Recasting from socket ${socket.id}.`;
  await appendEvent(state.runState, "cast_recast", { node: socket.id, materia: socketMateriaName(socket), type: resolvedSocketConfig(socket).type, previousFailure, itemKey: state.currentItemKey, itemLabel: state.currentItemLabel, itemLabelShort: shortMetadataLabel(state.currentItemLabel), visit: socketVisit(state, socket.id), reusedActivePrompt: isAgentResolvedSocket(socket) && Boolean(state.activeTurnPrompt) });
  await writeUsage(state.runState);
  saveCastState(pi, state);
  ctx.ui.setStatus("materia", materiaStatusLabel(state, socket));
  updateWidget(ctx, state, { replaceOwner: true });

  if (isAgentResolvedSocket(socket) && state.activeTurnPrompt) {
    updateToolScope(pi, socket.materia);
    await sendMateriaTurn(pi, ctx, state, state.activeTurnPrompt);
  } else {
    await startSocket(pi, ctx, state, socket);
  }
  ctx.ui.notify(`pi-materia cast ${state.castId} recast from socket "${socket.id}".`, "info");
  return state;
}

async function startMultiTurnFinalizationTurn(pi: ExtensionAPI, ctx: ExtensionContext, state: MateriaCastState): Promise<void> {
  const socket = currentSocketOrThrow(state);
  if (!isMultiTurnResolvedAgentSocket(socket)) {
    throw new Error(`Cannot finalize refinement for socket "${socket.id}" because its resolved materia is not multi-turn.`);
  }
  const appliedModel = await applyMateriaModelSettings(pi, ctx, { materiaName: resolvedSocketConfig(socket).materia, model: socket.materia.model, thinking: socket.materia.thinking });
  const materiaModel = materiaModelSelection(appliedModel);
  state.currentMateria = socketMateriaName(socket);
  state.currentMateriaModel = materiaModel;
  state.runState.currentMateria = socketMateriaName(socket);
  state.runState.currentMateriaModel = materiaModel;
  state.awaitingResponse = true;
  setCurrentSocketState(state, "awaiting_agent_response");
  state.multiTurnFinalizing = true;
  state.updatedAt = Date.now();
  const refinementTurn = currentRefinementTurn(state, socket.id) + 1;
  recordUsageModelSelection(state.runState.usage, { socket: socket.id, materia: resolvedSocketConfig(socket).materia, taskId: state.currentItemKey, attempt: state.runState.attempt, materiaModel });
  await writeUsage(state.runState);
  await appendEvent(state.runState, "materia_model_settings", { node: socket.id, materia: resolvedSocketConfig(socket).materia, visit: socketVisit(state, socket.id), itemKey: state.currentItemKey, itemLabel: state.currentItemLabel, itemLabelShort: shortMetadataLabel(state.currentItemLabel), materiaModel, refinementTurn, finalization: true });
  updateToolScope(pi, socket.materia);
  saveCastState(pi, state);
  await sendMateriaTurn(pi, ctx, state, buildMultiTurnFinalizationPrompt(state, socket));
}

export async function handleAgentEnd(pi: ExtensionAPI, event: { messages: unknown[] }, ctx: ExtensionContext): Promise<void> {
  const state = loadActiveCastState(ctx);
  if (!state?.active) return;
  const socketAtEnd = currentSocketOrThrow(state);
  const acceptingRefinement = !state.awaitingResponse && currentSocketState(state) === "awaiting_user_refinement" && isMultiTurnResolvedAgentSocket(socketAtEnd);
  if (!state.awaitingResponse && !acceptingRefinement) return;

  const latest = findLatestAssistantEntry(ctx.sessionManager.getEntries(), state.lastProcessedEntryId);
  if (!latest || latest.entry.id === state.lastProcessedEntryId) {
    const eventFailure = agentEndFailureMessage(event);
    if (!eventFailure) return;
    const error = new Error(`Pi agent turn failed before producing an assistant response for socket "${currentSocketId(state) ?? state.phase}": ${eventFailure}`);
    if (classifyTurnFailure(error) === "transient_transport") {
      await preserveAwaitingAfterTransientTransportFailure(pi, ctx, state, error);
      return;
    }
    const recovered = await handleSameSocketRecoverableTurnFailure(pi, ctx, state, error);
    if (!recovered) await failCast(pi, ctx, state, nonRecoverableTurnError(state, error));
    return;
  }

  const text = assistantText(latest.message);
  const agentError = assistantErrorMessage(latest.message);
  const wasAwaitingFinalization = state.awaitingResponse && currentSocketState(state) === "awaiting_agent_response" && state.multiTurnFinalizing === true;
  state.lastProcessedEntryId = latest.entry.id;
  state.lastAssistantText = text;
  captureUsage(state, latest.message);

  if (agentError) {
    const error = new Error(`Pi agent turn failed for socket "${currentSocketId(state) ?? state.phase}": ${agentError}`);
    if (classifyTurnFailure(error) === "transient_transport") {
      await preserveAwaitingAfterTransientTransportFailure(pi, ctx, state, error, { entryId: latest.entry.id });
      return;
    }
    const recovered = await handleSameSocketRecoverableTurnFailure(pi, ctx, state, error, { entryId: latest.entry.id });
    if (!recovered) await failCast(pi, ctx, state, nonRecoverableTurnError(state, error), latest.entry.id);
    return;
  }

  state.awaitingResponse = false;
  setCurrentSocketState(state, "idle");
  state.updatedAt = Date.now();

  try {
    const socket = currentSocketOrThrow(state);
    // Multi-turn pausing is materia-driven: if the resolved agent materia omits
    // multiTurn, even an interactive planning socket completes and advances.
    // Keep this generic runtime gate materia-name agnostic.
    if (isMultiTurnResolvedAgentSocket(socket)) {
      if (wasAwaitingFinalization) {
        state.multiTurnFinalizing = false;
        setCurrentSocketState(state, "idle");
        saveCastState(pi, state);
        await completeSocket(pi, ctx, state, text, latest.entry.id, { finalizedMultiTurn: true });
        return;
      }
      state.multiTurnFinalizing = false;
      const refinement = await recordMultiTurnRefinement(state, socket, text, latest.entry.id);
      setCurrentSocketState(state, "awaiting_user_refinement");
      state.runState.lastMessage = `Multi-turn socket ${socket.id} waiting for refinement; run /materia continue to finalize.`;
      await writeUsage(state.runState);
      await appendEvent(state.runState, "node_refinement", { node: socket.id, materia: socketMateriaName(socket), type: resolvedSocketConfig(socket).type, artifact: refinement.artifact, entryId: latest.entry.id, refinementTurn: refinement.turn, itemKey: state.currentItemKey, itemLabel: state.currentItemLabel, itemLabelShort: shortMetadataLabel(state.currentItemLabel), materiaModel: state.currentMateriaModel });
      saveCastState(pi, state);
      ctx.ui.setStatus("materia", materiaStatusLabel(state, socket, { suffix: "refine", includeItem: false }));
      updateWidget(ctx, state);
      ctx.ui.notify(`pi-materia multi-turn socket "${socket.id}" is waiting for refinement; run /materia continue to finalize.`, "info");
      return;
    }
    await completeSocket(pi, ctx, state, text, latest.entry.id);
  } catch (error) {
    state.active = false;
    state.phase = "failed";
    setCurrentSocketState(state, "failed");
    state.failedReason = error instanceof Error ? error.message : String(error);
    state.runState.lastMessage = state.failedReason;
    markRunEnded(state);
    await appendEvent(state.runState, "cast_end", { ok: false, error: state.failedReason });
    await writeUsage(state.runState);
    await appendManifest(state, { phase: "failed", entryId: latest.entry.id });
    saveCastState(pi, state);
    ctx.ui.setStatus("materia", "failed");
    updateWidget(ctx, state);
    ctx.ui.notify(`pi-materia cast failed: ${state.failedReason}`, "error");
  }
}

async function completeSocket(pi: ExtensionAPI, ctx: ExtensionContext, state: MateriaCastState, text: string, entryId: string, options: { finalizedMultiTurn?: boolean } = {}): Promise<void> {
  const config = await loadConfigFromState(state);
  const socket = currentSocketOrThrow(state);
  if (isMultiTurnResolvedAgentSocket(socket) && !options.finalizedMultiTurn) {
    throw new Error(`Internal multi-turn state error for socket "${socket.id}": completion requires explicit /materia continue finalization.`);
  }
  const artifact = await recordSocketOutput(state, socket, text, entryId);
  state.lastOutput = text;

  let parsed: unknown = text;
  if (resolvedSocketConfig(socket).parse === "json") {
    try {
      parsed = parseJson<unknown>(text);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid JSON output for socket "${socket.id}": ${detail}`);
    }
    parsed = validateHandoffJsonOutput(parsed, { socketId: socket.id, socket: socket.socket });
    state.lastJson = parsed;
    await writeFile(path.join(state.runDir, "nodes", safePathSegment(socket.id), `${socketVisit(state, socket.id)}.json`), JSON.stringify(parsed, null, 2));
  }

  applyGenericHandoffEnvelope(state, parsed, socket);
  applyAssignments(state, socket, parsed);
  const advanceTarget = applyAdvance(state, socket, parsed);
  const finalizedRefinement = isMultiTurnResolvedAgentSocket(socket);
  await appendEvent(state.runState, "node_complete", { node: socket.id, materia: socketMateriaName(socket), type: resolvedSocketConfig(socket).type, artifact, parsed: resolvedSocketConfig(socket).parse === "json", entryId, finalizedRefinement: finalizedRefinement || undefined, refinementTurn: finalizedRefinement ? currentRefinementTurn(state, socket.id) : undefined, itemKey: state.currentItemKey, itemLabel: state.currentItemLabel, itemLabelShort: shortMetadataLabel(state.currentItemLabel), materiaModel: state.currentMateriaModel });
  await assertBudget(config, state.runState, ctx);

  const nextTarget = advanceTarget ?? selectNextTarget(state, socket, parsed, config);
  await advanceToSocket(pi, ctx, state, nextTarget, entryId);
}

async function recordSocketOutput(state: MateriaCastState, socket: ResolvedMateriaSocket, text: string, entryId: string): Promise<string> {
  const visit = socketVisit(state, socket.id);
  const dir = path.join("nodes", safePathSegment(socket.id));
  const item = state.currentItemKey ? `-${safePathSegment(state.currentItemKey)}` : "";
  const artifact = path.join(dir, `${visit}${item}.md`);
  await mkdir(path.dirname(path.join(state.runDir, artifact)), { recursive: true });
  await writeFile(path.join(state.runDir, artifact), text);
  const finalizedRefinement = isMultiTurnResolvedAgentSocket(socket);
  await appendManifest(state, { phase: state.phase, node: socket.id, materia: socketMateriaName(socket), itemKey: state.currentItemKey, visit, entryId, artifact, kind: "node_output", finalized: finalizedRefinement || undefined, refinementTurn: finalizedRefinement ? currentRefinementTurn(state, socket.id) : undefined, materiaModel: state.currentMateriaModel });
  return artifact;
}

async function recordMultiTurnRefinement(state: MateriaCastState, socket: ResolvedMateriaSocket, text: string, entryId: string): Promise<{ artifact: string; turn: number }> {
  const visit = socketVisit(state, socket.id);
  const turn = nextRefinementTurn(state, socket.id);
  const dir = path.join("nodes", safePathSegment(socket.id));
  const item = state.currentItemKey ? `-${safePathSegment(state.currentItemKey)}` : "";
  const artifact = path.join(dir, `${visit}${item}.refinement-${turn}-${safePathSegment(entryId)}.md`);
  await mkdir(path.dirname(path.join(state.runDir, artifact)), { recursive: true });
  await writeFile(path.join(state.runDir, artifact), text);
  await appendManifest(state, { phase: state.phase, node: socket.id, materia: socketMateriaName(socket), itemKey: state.currentItemKey, visit, entryId, artifact, kind: "node_refinement", refinementTurn: turn, materiaModel: state.currentMateriaModel });
  return { artifact, turn };
}

async function advanceToSocket(pi: ExtensionAPI, ctx: ExtensionContext, state: MateriaCastState, targetId: string | undefined, entryId: string): Promise<void> {
  const target = targetId ?? "end";
  if (target === "end") return await finishCast(pi, ctx, state, entryId, "Cast complete.");
  const socket = resolvedPipelineSockets(state)[target];
  if (!socket) throw new Error(`Unknown graph target "${target}"`);
  await startSocket(pi, ctx, state, socket);
}

async function startSocket(pi: ExtensionAPI, ctx: ExtensionContext, state: MateriaCastState, socket: ResolvedMateriaSocket): Promise<void> {
  const config = await loadConfigFromState(state);
  const hasItem = setCurrentItem(state, socket);
  const loop = loopIteratorForSocket(state.pipeline, socket.id);
  if (loop && !hasItem) return await advanceToSocket(pi, ctx, state, loop.done ?? "end", "foreach-empty");
  enforceSocketVisitLimit(state, socket, config);
  const attempt = startTaskAttempt(state, socket.id);

  state.phase = socket.id;
  setCurrentSocketId(state, socket.id);
  state.currentMateria = socketMateriaName(socket);
  state.currentMateriaModel = undefined;
  state.awaitingResponse = true;
  setCurrentSocketState(state, isAgentResolvedSocket(socket) ? "awaiting_agent_response" : "running_utility");
  state.updatedAt = Date.now();
  state.runState.currentNode = socket.id;
  state.runState.currentMateria = socketMateriaName(socket);
  state.runState.currentMateriaModel = undefined;
  state.runState.currentTask = state.currentItemLabel;
  state.runState.attempt = attempt;
  state.runState.lastMessage = socket.id;
  await writeUsage(state.runState);
  await appendEvent(state.runState, "node_start", { node: socket.id, materia: socketMateriaName(socket), type: resolvedSocketConfig(socket).type, itemKey: state.currentItemKey, itemLabel: state.currentItemLabel, itemLabelShort: shortMetadataLabel(state.currentItemLabel), visit: socketVisit(state, socket.id) });
  saveCastState(pi, state);
  updateWidget(ctx, state);
  ctx.ui.setStatus("materia", materiaStatusLabel(state, socket));

  if (!isAgentResolvedSocket(socket)) {
    state.awaitingResponse = false;
    setCurrentSocketState(state, "running_utility");
    state.currentMateria = undefined;
    state.currentMateriaModel = undefined;
    state.runState.currentMateria = undefined;
    state.runState.currentMateriaModel = undefined;
    saveCastState(pi, state);
    try {
      const result = await executeUtilitySocket(state, socket);
      await completeSocket(pi, ctx, state, result.output, result.entryId);
    } catch (error) {
      await failCast(pi, ctx, state, error, `utility:${socket.id}:${socketVisit(state, socket.id)}`);
    }
    return;
  }

  state.awaitingResponse = true;
  setCurrentSocketState(state, "awaiting_agent_response");
  saveCastState(pi, state);
  const appliedModel = await applyMateriaModelSettings(pi, ctx, { materiaName: resolvedSocketConfig(socket).materia, model: socket.materia.model, thinking: socket.materia.thinking });
  const materiaModel = materiaModelSelection(appliedModel);
  state.currentMateriaModel = materiaModel;
  state.runState.currentMateriaModel = materiaModel;
  recordUsageModelSelection(state.runState.usage, { socket: socket.id, materia: resolvedSocketConfig(socket).materia, taskId: state.currentItemKey, attempt: state.runState.attempt, materiaModel });
  await writeUsage(state.runState);
  await appendEvent(state.runState, "materia_model_settings", { node: socket.id, materia: resolvedSocketConfig(socket).materia, visit: socketVisit(state, socket.id), itemKey: state.currentItemKey, itemLabel: state.currentItemLabel, itemLabelShort: shortMetadataLabel(state.currentItemLabel), materiaModel });
  saveCastState(pi, state);
  updateToolScope(pi, socket.materia);
  await sendMateriaTurn(pi, ctx, state, buildSocketPrompt(state, socket));
}

async function executeUtilitySocket(state: MateriaCastState, socket: Extract<ResolvedMateriaSocket, { socket: { type: "utility" } }>): Promise<{ output: string; entryId: string }> {
  const visit = socketVisit(state, socket.id);
  const input = buildUtilityInput(state, socket);
  const inputArtifact = await recordUtilityInput(state, socket, input);
  await appendEvent(state.runState, "utility_input", { node: socket.id, artifact: inputArtifact, itemKey: state.currentItemKey, itemLabel: state.currentItemLabel, itemLabelShort: shortMetadataLabel(state.currentItemLabel), visit });

  const utilityConfig = resolvedSocketConfig(socket);
  const params = utilityConfig.params ?? {};
  let output: string;
  if (utilityConfig.command) {
    output = await executeCommandUtility(state, socket, input);
  } else if (Object.prototype.hasOwnProperty.call(params, "output")) {
    const value = params.output;
    output = typeof value === "string" ? value : stringifyDeterministicHandoffOutput(value);
  } else if (hasBuiltInUtility(utilityConfig.utility)) {
    output = await executeBuiltInUtility(utilityConfig.utility, input as BuiltInUtilityInput);
  } else {
    throw new Error(`Unknown utility alias "${utilityConfig.utility}" for socket "${socket.id}".`);
  }

  return { output, entryId: `utility:${socket.id}:${visit}` };
}

async function executeCommandUtility(state: MateriaCastState, socket: Extract<ResolvedMateriaSocket, { socket: { type: "utility" } }>, input: Record<string, unknown>): Promise<string> {
  const command = resolvedSocketConfig(socket).command;
  if (!command || command.length === 0) throw new Error(`Utility socket "${socket.id}" has no explicit command configured.`);

  const timeoutMs = resolvedSocketConfig(socket).timeoutMs ?? DEFAULT_UTILITY_TIMEOUT_MS;
  const child = spawn(command[0], command.slice(1), { cwd: state.cwd, stdio: ["pipe", "pipe", "pipe"], env: process.env });
  const stdout = createBoundedCapture(MAX_UTILITY_OUTPUT_BYTES);
  const stderr = createBoundedCapture(MAX_UTILITY_OUTPUT_BYTES);
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 1_000).unref();
  }, timeoutMs);
  timeout.unref();

  child.stdout.on("data", (chunk: Buffer | string) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer | string) => stderr.push(chunk));

  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal }));
  });

  child.stdin.end(`${JSON.stringify(input)}\n`);

  let result: { code: number | null; signal: NodeJS.Signals | null };
  try {
    result = await closed;
  } finally {
    clearTimeout(timeout);
  }

  const stdoutText = stdout.text();
  const stderrText = stderr.text();
  const artifacts = await recordCommandArtifacts(state, socket, stdoutText, stderrText, stdout.truncated, stderr.truncated);
  await appendEvent(state.runState, "utility_command", { node: socket.id, command, code: result.code, signal: result.signal, timedOut, timeoutMs, stdoutArtifact: artifacts.stdoutArtifact, stderrArtifact: artifacts.stderrArtifact, stdoutTruncated: stdout.truncated, stderrTruncated: stderr.truncated });

  if (timedOut) {
    throw new Error(`Utility command timed out for socket "${socket.id}" after ${timeoutMs}ms: ${formatCommandForError(command)}. stdout: ${artifacts.stdoutArtifact}; stderr: ${artifacts.stderrArtifact}`);
  }
  if (result.code !== 0) {
    const summary = summarizeStderr(stderrText, stderr.truncated);
    throw new Error(`Utility command failed for socket "${socket.id}": ${formatCommandForError(command)} exited with code ${result.code ?? `signal ${result.signal ?? "unknown"}`}. stderr: ${summary}. stdout: ${artifacts.stdoutArtifact}; stderr: ${artifacts.stderrArtifact}`);
  }
  return stdoutText;
}

function createBoundedCapture(maxBytes: number): { push(chunk: Buffer | string): void; text(): string; truncated: boolean } {
  const chunks: Buffer[] = [];
  let bytes = 0;
  let truncated = false;
  return {
    push(chunk) {
      if (bytes >= maxBytes) {
        truncated = true;
        return;
      }
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = maxBytes - bytes;
      if (buffer.byteLength > remaining) {
        chunks.push(buffer.subarray(0, remaining));
        bytes += remaining;
        truncated = true;
      } else {
        chunks.push(buffer);
        bytes += buffer.byteLength;
      }
    },
    text() {
      return Buffer.concat(chunks).toString("utf8");
    },
    get truncated() {
      return truncated;
    },
  };
}

async function recordCommandArtifacts(state: MateriaCastState, socket: ResolvedMateriaSocket, stdout: string, stderr: string, stdoutTruncated: boolean, stderrTruncated: boolean): Promise<{ stdoutArtifact: string; stderrArtifact: string; metaArtifact: string }> {
  const visit = socketVisit(state, socket.id);
  const dir = path.join("nodes", safePathSegment(socket.id));
  const item = state.currentItemKey ? `-${safePathSegment(state.currentItemKey)}` : "";
  const stdoutArtifact = path.join(dir, `${visit}${item}.command.stdout.txt`);
  const stderrArtifact = path.join(dir, `${visit}${item}.command.stderr.txt`);
  const metaArtifact = path.join(dir, `${visit}${item}.command.json`);
  await mkdir(path.dirname(path.join(state.runDir, stdoutArtifact)), { recursive: true });
  await writeFile(path.join(state.runDir, stdoutArtifact), stdout);
  await writeFile(path.join(state.runDir, stderrArtifact), stderr);
  await writeFile(path.join(state.runDir, metaArtifact), JSON.stringify({ stdoutArtifact, stderrArtifact, stdoutTruncated, stderrTruncated, maxBytes: MAX_UTILITY_OUTPUT_BYTES }, null, 2));
  await appendManifest(state, { phase: state.phase, node: socket.id, materia: socketMateriaName(socket), itemKey: state.currentItemKey, visit, entryId: `utility:${socket.id}:${visit}:command:stdout`, artifact: stdoutArtifact });
  await appendManifest(state, { phase: state.phase, node: socket.id, materia: socketMateriaName(socket), itemKey: state.currentItemKey, visit, entryId: `utility:${socket.id}:${visit}:command:stderr`, artifact: stderrArtifact });
  await appendManifest(state, { phase: state.phase, node: socket.id, materia: socketMateriaName(socket), itemKey: state.currentItemKey, visit, entryId: `utility:${socket.id}:${visit}:command:meta`, artifact: metaArtifact });
  return { stdoutArtifact, stderrArtifact, metaArtifact };
}

function summarizeStderr(stderr: string, truncated: boolean): string {
  const summary = stderr.trim().replace(/\s+/g, " ").slice(0, MAX_UTILITY_ERROR_SUMMARY_LENGTH);
  return `${summary || "<empty>"}${truncated ? " (truncated)" : ""}`;
}

function formatCommandForError(command: string[]): string {
  return command.map((part) => JSON.stringify(part)).join(" ");
}

function buildUtilityInput(state: MateriaCastState, socket: Extract<ResolvedMateriaSocket, { socket: { type: "utility" } }>): Record<string, unknown> {
  const loop = resolvedSocketConfig(socket).foreach ?? loopIteratorForSocket(state.pipeline, socket.id);
  const cursorName = loop?.cursor ?? (loop ? `${socket.id}Index` : undefined);
  return {
    cwd: state.cwd,
    runDir: state.runDir,
    request: state.request,
    castId: state.castId,
    socketId: socket.id,
    // Legacy utility-command input alias retained for existing utility scripts.
    nodeId: socket.id,
    params: resolvedSocketConfig(socket).params ?? {},
    state: state.data,
    item: currentItem(state) ?? null,
    itemKey: state.currentItemKey ?? null,
    itemLabel: state.currentItemLabel ?? null,
    cursor: cursorName ? { name: cursorName, index: state.cursors[cursorName] ?? 0 } : null,
    cursors: state.cursors,
  };
}

async function recordUtilityInput(state: MateriaCastState, socket: ResolvedMateriaSocket, input: Record<string, unknown>): Promise<string> {
  const visit = socketVisit(state, socket.id);
  const dir = path.join("nodes", safePathSegment(socket.id));
  const item = state.currentItemKey ? `-${safePathSegment(state.currentItemKey)}` : "";
  const artifact = path.join(dir, `${visit}${item}.input.json`);
  await mkdir(path.dirname(path.join(state.runDir, artifact)), { recursive: true });
  await writeFile(path.join(state.runDir, artifact), JSON.stringify(input, null, 2));
  await appendManifest(state, { phase: state.phase, node: socket.id, materia: socketMateriaName(socket), itemKey: state.currentItemKey, visit, entryId: `utility:${socket.id}:${visit}:input`, artifact });
  return artifact;
}

async function preserveAwaitingAfterTransientTransportFailure(pi: ExtensionAPI, ctx: ExtensionContext, state: MateriaCastState, error: unknown, options: { entryId?: string } = {}): Promise<void> {
  state.active = true;
  state.awaitingResponse = true;
  setCurrentSocketState(state, "awaiting_agent_response");
  state.updatedAt = Date.now();
  state.runState.lastMessage = `Transient transport failure while awaiting ${recoveryDiagnosticLabel(state)}; preserving active Pi turn: ${errorMessage(error)}`;
  await appendEvent(state.runState, "transient_transport_turn_failure", { warning: true, error: errorMessage(error), entryId: options.entryId, node: currentSocketId(state), itemKey: state.currentItemKey, itemLabel: state.currentItemLabel, itemLabelShort: shortMetadataLabel(state.currentItemLabel), mode: recoveryTurnMode(state) });
  await writeUsage(state.runState);
  saveCastState(pi, state);
  updateWidget(ctx, state);
  ctx.ui.notify(`pi-materia warning: ${state.runState.lastMessage}`, "warning");
}

async function handleSameSocketRecoverableTurnFailure(pi: ExtensionAPI, ctx: ExtensionContext, state: MateriaCastState, error: unknown, options: { entryId?: string } = {}): Promise<boolean> {
  const reason = classifyRecoverableTurnFailure(error);
  if (!reason) {
    return false;
  }

  const key = recoveryIdentityKey(state);
  state.recoveryAttempts ??= {};
  const allowance = ensureRecoveryAllowance(state, key);
  const previousAttempts = state.recoveryAttempts[key] ?? 0;
  const maxAttempts = allowance.effectiveMaxAttempts;
  if (previousAttempts >= maxAttempts) {
    const exhausted = `Same-socket recovery exhausted for ${recoveryDiagnosticLabel(state)} after ${previousAttempts}/${maxAttempts} attempt(s): ${errorMessage(error)}`;
    state.recoveryExhaustion = {
      kind: "same_node_recovery_exhausted",
      reason,
      key,
      attempts: previousAttempts,
      originalMaxAttempts: allowance.originalMaxAttempts,
      effectiveMaxAttempts: allowance.effectiveMaxAttempts,
      reviveCount: allowance.reviveCount,
      failedReason: exhausted,
      node: currentSocketId(state),
      itemKey: state.currentItemKey,
      mode: recoveryTurnMode(state),
      exhaustedAt: Date.now(),
    };
    await appendEvent(state.runState, "same_node_recovery_exhausted", { reason, key, attempts: previousAttempts, originalMaxAttempts: allowance.originalMaxAttempts, effectiveMaxAttempts: allowance.effectiveMaxAttempts, maxAttempts, reviveCount: allowance.reviveCount, error: errorMessage(error), entryId: options.entryId, node: currentSocketId(state), itemKey: state.currentItemKey, mode: recoveryTurnMode(state) });
    await failCast(pi, ctx, state, new Error(exhausted), options.entryId, { preserveRecoveryExhaustion: true });
    return true;
  }

  const attempt = previousAttempts + 1;
  state.recoveryAttempts[key] = attempt;
  state.awaitingResponse = true;
  setCurrentSocketState(state, "awaiting_agent_response");
  state.updatedAt = Date.now();
  state.runState.lastMessage = `Retrying ${recoveryDiagnosticLabel(state)} after recoverable ${reason} failure (${attempt}/${maxAttempts}).`;
  await appendEvent(state.runState, "same_node_recovery_start", { reason, key, attempt, originalMaxAttempts: allowance.originalMaxAttempts, effectiveMaxAttempts: allowance.effectiveMaxAttempts, maxAttempts, reviveCount: allowance.reviveCount, error: errorMessage(error), entryId: options.entryId, node: currentSocketId(state), itemKey: state.currentItemKey, itemLabel: state.currentItemLabel, itemLabelShort: shortMetadataLabel(state.currentItemLabel), visit: currentSocketVisit(state, undefined), mode: recoveryTurnMode(state) });
  await writeUsage(state.runState);
  saveCastState(pi, state);

  try {
    if (reason === "context_window") await runSameSocketRecoveryAction(pi, ctx, state, { action: "compact", reason, key, attempt, maxAttempts, entryId: options.entryId });
    updateToolScope(pi, currentMateria(state));
    await sendMateriaTurn(pi, ctx, state, buildSameSocketRecoveryPrompt(state), { skipProactiveCompaction: true });
    await appendEvent(state.runState, "same_node_recovery_retry", { reason, key, attempt, originalMaxAttempts: allowance.originalMaxAttempts, effectiveMaxAttempts: allowance.effectiveMaxAttempts, maxAttempts, reviveCount: allowance.reviveCount, node: currentSocketId(state), itemKey: state.currentItemKey, mode: recoveryTurnMode(state) });
    saveCastState(pi, state);
    updateWidget(ctx, state);
    ctx.ui.notify(`pi-materia retrying ${recoveryDiagnosticLabel(state)} after recoverable ${reason} failure (${attempt}/${maxAttempts}).`, "warning");
    return true;
  } catch (retryError) {
    await appendEvent(state.runState, "same_node_recovery_retry_failed", { reason, key, attempt, maxAttempts, error: errorMessage(retryError), originalError: errorMessage(error), entryId: options.entryId, node: currentSocketId(state), itemKey: state.currentItemKey, mode: recoveryTurnMode(state) });
    await failCast(pi, ctx, state, new Error(`Same-socket recovery retry failed for ${recoveryDiagnosticLabel(state)}: ${errorMessage(retryError)}. Original failure: ${errorMessage(error)}`), options.entryId);
    return true;
  }
}

async function runSameSocketRecoveryAction(pi: ExtensionAPI, ctx: ExtensionContext, state: MateriaCastState, options: { action: "compact"; reason: "context_window"; key: string; attempt: number; maxAttempts: number; entryId?: string }): Promise<void> {
  await appendEvent(state.runState, "same_node_recovery_action_start", { action: options.action, reason: options.reason, key: options.key, attempt: options.attempt, maxAttempts: options.maxAttempts, entryId: options.entryId, node: currentSocketId(state), itemKey: state.currentItemKey, mode: recoveryTurnMode(state) });
  saveCastState(pi, state);

  try {
    const result = await forceContextCompaction(ctx, state);
    await appendEvent(state.runState, "same_node_recovery_action_complete", { action: options.action, reason: options.reason, key: options.key, attempt: options.attempt, maxAttempts: options.maxAttempts, entryId: options.entryId, node: currentSocketId(state), itemKey: state.currentItemKey, mode: recoveryTurnMode(state), result: summarizeCompactionResult(result) });
    saveCastState(pi, state);
  } catch (actionError) {
    await appendEvent(state.runState, "same_node_recovery_action_failed", { action: options.action, reason: options.reason, key: options.key, attempt: options.attempt, maxAttempts: options.maxAttempts, entryId: options.entryId, node: currentSocketId(state), itemKey: state.currentItemKey, mode: recoveryTurnMode(state), error: errorMessage(actionError) });
    throw new Error(`Same-socket recovery action compact failed for ${recoveryDiagnosticLabel(state)}: ${errorMessage(actionError)}`);
  }
}

function forceContextCompaction(ctx: ExtensionContext, state: MateriaCastState): Promise<unknown> {
  return compactContext(ctx, `Pi Materia forced context-window recovery for ${recoveryDiagnosticLabel(state)}. Preserve the active cast state, task requirements, and any durable artifacts/events needed to continue the same turn.`);
}

function compactContext(ctx: ExtensionContext, customInstructions: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    try {
      ctx.compact({ customInstructions, onComplete: resolve, onError: reject });
    } catch (error) {
      reject(error);
    }
  });
}

function summarizeCompactionResult(result: unknown): unknown {
  if (!result || typeof result !== "object") return result;
  const value = result as Record<string, unknown>;
  return Object.fromEntries(Object.entries(value).filter(([key]) => ["tokensBefore", "tokensAfter", "entriesRemoved", "summaryTokens", "firstKeptEntryId"].includes(key)));
}

function effectiveContextWindow(ctx: ExtensionContext, usage: { contextWindow?: number }): number | undefined {
  const modelContextWindow = ctx.model?.contextWindow;
  if (Number.isFinite(modelContextWindow) && modelContextWindow != null && modelContextWindow > 0) return modelContextWindow;
  return Number.isFinite(usage.contextWindow) && usage.contextWindow != null && usage.contextWindow > 0 ? usage.contextWindow : undefined;
}

async function maybeRunProactiveCompaction(pi: ExtensionAPI, ctx: ExtensionContext, state: MateriaCastState): Promise<void> {
  // This is a pre-turn transcript snapshot from Pi core. It does not include
  // request material added later in this turn: the hidden Materia prompt,
  // synthetic isolated cast context, before_agent_start system-prompt suffix,
  // active-turn tool results retained by context isolation, or provider-specific
  // tokenization overhead. Keep docs/materia-compaction-budgeting.md in sync
  // when changing this decision point.
  const usage = ctx.getContextUsage();
  if (!usage) return;
  const config = await loadConfigFromState(state);
  const contextWindow = effectiveContextWindow(ctx, usage);
  const threshold = resolveProactiveCompactionThreshold(config.compaction, contextWindow);
  const thresholdPercent = threshold.thresholdPercent;
  const percent = usage.tokens != null && contextWindow != null && contextWindow > 0 ? (usage.tokens / contextWindow) * 100 : usage.percent;
  if (percent == null || percent < thresholdPercent) return;

  const eventBase = {
    action: "compact" as const,
    reason: "context_pressure" as const,
    thresholdPercent,
    thresholdMode: threshold.mode,
    thresholdTier: threshold.tier,
    tokens: usage.tokens,
    contextWindow,
    percent,
    socket: currentSocketId(state),
    itemKey: state.currentItemKey,
    itemLabel: state.currentItemLabel,
    itemLabelShort: shortMetadataLabel(state.currentItemLabel),
    visit: currentSocketVisit(state, undefined),
    mode: recoveryTurnMode(state),
  };
  await appendEvent(state.runState, "proactive_compaction_start", eventBase);
  saveCastState(pi, state);

  try {
    const result = await compactContext(ctx, `Pi Materia proactive context-pressure compaction before ${recoveryDiagnosticLabel(state)}. Preserve the active cast state, task requirements, and any durable artifacts/events needed to continue the same turn.`);
    await appendEvent(state.runState, "proactive_compaction_complete", { ...eventBase, result: summarizeCompactionResult(result) });
    saveCastState(pi, state);
  } catch (error) {
    const message = `Proactive compaction failed before ${recoveryDiagnosticLabel(state)}; continuing turn so same-socket recovery can handle any later context-window failure: ${errorMessage(error)}`;
    state.runState.lastMessage = message;
    await appendEvent(state.runState, "proactive_compaction_failed", { ...eventBase, error: errorMessage(error), warning: true });
    await writeUsage(state.runState);
    saveCastState(pi, state);
    ctx.ui.notify(`pi-materia warning: ${message}`, "warning");
  }
}

export type TurnFailureClassification = "context_window" | "transient_transport";

export function classifyTurnFailure(error: unknown): TurnFailureClassification | undefined {
  const message = errorMessage(error);
  if (isContextWindowFailureMessage(message)) return "context_window";
  if (isPlainWebSocketTransportFailure(message)) return "transient_transport";
  return undefined;
}

function classifyRecoverableTurnFailure(error: unknown): "context_window" | undefined {
  return classifyTurnFailure(error) === "context_window" ? "context_window" : undefined;
}

function isContextWindowFailureMessage(message: string): boolean {
  return /context[_-]?length[_-]?exceeded|context[_-]?window[_-]?exceeded|context (window|length|limit|overflow)|token limit|max(?:imum)? tokens|input too long|request too large|too many tokens/i.test(message);
}

function isPlainWebSocketTransportFailure(message: string): boolean {
  const normalized = message.trim().replace(/\s+/g, " ");
  return /(?:^|:\s*)(?:error:\s*)?websocket (?:error|closed|close|connection (?:closed|error|lost)|disconnected)(?:\s+\d{3,4})?\.?$/i.test(normalized);
}

function buildSameSocketRecoveryPrompt(state: MateriaCastState): string {
  if (state.activeTurnPrompt) return state.activeTurnPrompt;
  const socket = currentSocketOrThrow(state);
  if (recoveryTurnMode(state) === "finalization") return buildMultiTurnFinalizationPrompt(state, socket);
  return buildSocketPrompt(state, socket);
}

function recoveryTurnMode(state: MateriaCastState): "normal" | "refinement" | "finalization" {
  if (state.multiTurnFinalizing === true) return "finalization";
  return isActiveMultiTurnSocket(state) ? "refinement" : "normal";
}

function recoveryIdentityKey(state: MateriaCastState): string {
  const socketId = currentSocketId(state) ?? state.phase;
  const visit = currentSocketVisit(state, 0);
  const refinementTurn = currentSocketId(state) ? currentRefinementTurn(state, currentSocketId(state)!) : 0;
  return JSON.stringify([recoveryTurnMode(state), socketId, state.currentItemKey ?? "__singleton__", visit, refinementTurn]);
}

function ensureRecoveryAllowance(state: MateriaCastState, key: string): MateriaRecoveryAllowance {
  state.recoveryAllowances ??= {};
  const existing = state.recoveryAllowances[key];
  if (isValidRecoveryAllowance(existing)) return existing;
  const originalMaxAttempts = DEFAULT_MAX_SAME_SOCKET_RECOVERY_ATTEMPTS;
  const allowance: MateriaRecoveryAllowance = { originalMaxAttempts, effectiveMaxAttempts: originalMaxAttempts, reviveCount: 0 };
  state.recoveryAllowances[key] = allowance;
  return allowance;
}

function isValidRecoveryAllowance(value: unknown): value is MateriaRecoveryAllowance {
  const allowance = value as Partial<MateriaRecoveryAllowance> | undefined;
  return Boolean(
    allowance &&
    Number.isSafeInteger(allowance.originalMaxAttempts) && allowance.originalMaxAttempts! > 0 &&
    Number.isSafeInteger(allowance.effectiveMaxAttempts) && allowance.effectiveMaxAttempts! >= allowance.originalMaxAttempts! &&
    Number.isSafeInteger(allowance.reviveCount) && allowance.reviveCount! >= 0
  );
}

function isRevivableCastState(state: MateriaCastState): boolean {
  if (state.active || (state.phase !== "failed" && currentSocketState(state) !== "failed")) return false;
  const exhaustion = state.recoveryExhaustion;
  if (!exhaustion || exhaustion.kind !== "same_node_recovery_exhausted" || !exhaustion.key) return false;
  if (!exhaustion.failedReason || exhaustion.failedReason !== state.failedReason) return false;
  return isValidRecoveryAllowance(state.recoveryAllowances?.[exhaustion.key]);
}

export interface MateriaReviveAllowanceResult {
  key: string;
  priorEffectiveMaxAttempts: number;
  increment: number;
  newEffectiveMaxAttempts: number;
  reviveCount: number;
}

export function extendSameSocketRecoveryAllowanceForRevive(state: MateriaCastState): MateriaReviveAllowanceResult {
  if (state.active) throw new Error(`pi-materia cast ${state.castId} is still active and cannot be revived.`);
  if (state.phase !== "failed" && currentSocketState(state) !== "failed") throw new Error(`pi-materia cast ${state.castId} is not failed and cannot be revived.`);
  const exhaustion = state.recoveryExhaustion;
  if (!exhaustion || exhaustion.kind !== "same_node_recovery_exhausted") {
    throw new Error(`pi-materia cast ${state.castId} is not revivable: missing structured same-socket recovery exhaustion metadata. Use /materia recast for general failed casts.`);
  }
  if (!exhaustion.key) throw new Error(`pi-materia cast ${state.castId} is not revivable: exhausted recovery context is missing.`);
  if (!exhaustion.failedReason || exhaustion.failedReason !== state.failedReason) {
    throw new Error(`pi-materia cast ${state.castId} is not revivable: same-socket recovery exhaustion metadata does not match the current terminal failure. Use /materia recast for general failed casts.`);
  }
  const allowance = state.recoveryAllowances?.[exhaustion.key];
  if (!isValidRecoveryAllowance(allowance)) {
    throw new Error(`pi-materia cast ${state.castId} is not revivable: recovery allowance metadata is missing or invalid. Use /materia recast instead.`);
  }
  const priorEffectiveMaxAttempts = allowance.effectiveMaxAttempts;
  const increment = allowance.originalMaxAttempts;
  allowance.effectiveMaxAttempts = priorEffectiveMaxAttempts + increment;
  allowance.reviveCount += 1;
  exhaustion.effectiveMaxAttempts = allowance.effectiveMaxAttempts;
  exhaustion.originalMaxAttempts = allowance.originalMaxAttempts;
  exhaustion.reviveCount = allowance.reviveCount;
  state.updatedAt = Date.now();
  return { key: exhaustion.key, priorEffectiveMaxAttempts, increment, newEffectiveMaxAttempts: allowance.effectiveMaxAttempts, reviveCount: allowance.reviveCount };
}

function recoveryDiagnosticLabel(state: MateriaCastState): string {
  const item = state.currentItemKey ? ` item ${JSON.stringify(state.currentItemKey)}` : "";
  return `${recoveryTurnMode(state)} turn for socket "${currentSocketId(state) ?? state.phase}"${item}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function nonRecoverableTurnError(state: MateriaCastState, error: unknown): Error {
  return new Error(`Non-recoverable turn failure for ${recoveryDiagnosticLabel(state)} (same-socket recovery not attempted): ${errorMessage(error)}`);
}

async function failCast(pi: ExtensionAPI, ctx: ExtensionContext, state: MateriaCastState, error: unknown, entryId?: string, options: { preserveRecoveryExhaustion?: boolean } = {}): Promise<void> {
  if (!options.preserveRecoveryExhaustion) state.recoveryExhaustion = undefined;
  state.active = false;
  state.awaitingResponse = false;
  setCurrentSocketState(state, "failed");
  state.phase = "failed";
  state.failedReason = error instanceof Error ? error.message : String(error);
  state.runState.lastMessage = state.failedReason;
  markRunEnded(state);
  await appendEvent(state.runState, "cast_end", { ok: false, error: state.failedReason, entryId, node: currentSocketId(state) });
  await writeUsage(state.runState);
  await appendManifest(state, { phase: "failed", node: currentSocketId(state), materia: state.currentMateria, itemKey: state.currentItemKey, entryId });
  saveCastState(pi, state);
  ctx.ui.setStatus("materia", "failed");
  updateWidget(ctx, state);
  ctx.ui.notify(`pi-materia cast failed: ${state.failedReason}`, "error");
}

function markRunEnded(state: MateriaCastState): void {
  state.runState.endedAt ??= Date.now();
}

async function resolvePersistedCastLoadoutName(state: MateriaCastState): Promise<string | undefined> {
  try {
    const config = parseJson<PiMateriaConfig>(await readFile(path.join(state.runDir, "config.resolved.json"), "utf8"));
    return getEffectivePipelineConfig(config).loadoutName;
  } catch {
    return undefined;
  }
}

function enforceSocketVisitLimit(state: MateriaCastState, socket: ResolvedMateriaSocket, config: PiMateriaConfig): void {
  const count = (state.visits[socket.id] ?? 0) + 1;
  const limit = resolvedSocketConfig(socket).limits?.maxVisits ?? config.limits?.maxSocketVisits ?? config.limits?.maxNodeVisits ?? DEFAULT_MAX_SOCKET_VISITS;
  if (count > limit) throw new Error(`Materia socket visit limit exceeded for ${socket.id} (${count}/${limit}).`);
  state.visits[socket.id] = count;
}

async function finishCast(pi: ExtensionAPI, ctx: ExtensionContext, state: MateriaCastState, entryId: string, message: string): Promise<void> {
  state.active = false;
  state.phase = "complete";
  state.awaitingResponse = false;
  setCurrentSocketState(state, "complete");
  state.recoveryExhaustion = undefined;
  state.updatedAt = Date.now();
  state.runState.lastMessage = message;
  markRunEnded(state);
  await writeUsage(state.runState);
  await appendEvent(state.runState, "cast_end", { ok: true, usage: state.runState.usage, entryId });
  await appendManifest(state, { phase: "complete", entryId });
  saveCastState(pi, state);
  ctx.ui.setStatus("materia", "done");
  updateWidget(ctx, state);
  showUsageSummary(ctx, state.runState);
  ctx.ui.notify(`pi-materia cast complete. ${formatUsage(state.runState.usage, state.runState.usage.costKind)}`, "info");
}

async function sendMateriaTurn(pi: ExtensionAPI, ctx: ExtensionContext, state: MateriaCastState, prompt: string, options: { skipProactiveCompaction?: boolean } = {}): Promise<void> {
  state.activeTurnPrompt = prompt;
  saveCastState(pi, state);
  if (!options.skipProactiveCompaction) await maybeRunProactiveCompaction(pi, ctx, state);
  const contextArtifact = await writeContextArtifact(pi, state, prompt);
  await appendManifest(state, { phase: state.phase, node: currentSocketId(state), materia: state.currentMateria, itemKey: state.currentItemKey, visit: currentSocketVisit(state, undefined), artifact: contextArtifact, kind: "context", materiaModel: state.currentMateriaModel });

  const display = formatMateriaNotificationDisplay(state.currentMateria, currentSocketId(state));
  pi.sendMessage({
    customType: "pi-materia",
    content: formatMateriaCastContent(state.currentMateria, currentSocketId(state), state.currentItemLabel),
    display: true,
    details: { prefix: "materia", nodeId: currentSocketId(state), materiaName: display.materiaName, socketOrdinal: display.socketOrdinal, itemKey: state.currentItemKey, itemLabel: state.currentItemLabel, eventType: "materia_prompt", materiaModel: state.currentMateriaModel },
  });

  pi.appendEntry("pi-materia-context", { phase: state.phase, nodeId: currentSocketId(state), materiaName: state.currentMateria, itemKey: state.currentItemKey, itemLabel: state.currentItemLabel, itemLabelShort: shortMetadataLabel(state.currentItemLabel), artifact: contextArtifact, materiaModel: state.currentMateriaModel });
  pi.sendMessage({
    customType: "pi-materia-prompt",
    content: prompt,
    display: false,
    details: { phase: state.phase, nodeId: currentSocketId(state), materiaName: state.currentMateria, itemKey: state.currentItemKey, itemLabel: state.currentItemLabel, materiaModel: state.currentMateriaModel },
  }, { triggerTurn: true });
}

async function writeContextArtifact(pi: ExtensionAPI, state: MateriaCastState, prompt: string, suffix?: string): Promise<string> {
  const relativePath = contextArtifactPath(state, suffix);
  const fullPath = path.join(state.runDir, relativePath);
  await mkdir(path.dirname(fullPath), { recursive: true });
  const activeTools = pi.getActiveTools();
  const materiaModel = state.currentMateriaModel;
  const model = materiaModel?.label ?? "active Pi model";
  const thinking = materiaModel?.thinking ?? (materiaModel?.thinkingExplicit ? materiaModel.requestedThinking : undefined) ?? "active Pi thinking";
  const modelSource = formatModelSource(materiaModel);
  const thinkingSource = formatThinkingSource(materiaModel);
  const content = [
    "# Materia Isolated Context",
    "",
    `cast: ${state.castId}`,
    `socket: ${currentSocketId(state) ?? "-"}`,
    `materia: ${state.currentMateria ?? "-"}`,
    `item: ${state.currentItemLabel ?? "-"}`,
    `visit: ${currentSocketId(state) ? currentSocketVisit(state) : "-"}`,
    `model: ${model}`,
    `model source: ${modelSource}`,
    `thinking: ${thinking}`,
    `thinking source: ${thinkingSource}`,
    `active tools: ${activeTools.length ? activeTools.join(", ") : "none"}`,
    `timestamp: ${new Date().toISOString()}`,
    "",
    "## Synthetic cast context",
    "",
    buildSyntheticCastContext(state),
    "",
    "## Hidden materia prompt",
    "",
    prompt,
  ].join("\n");
  await writeFile(fullPath, content);
  return relativePath;
}

function materiaModelSelection(applied: AppliedMateriaModelSettings): MateriaModelSelection {
  const model = applied.modelId ?? applied.modelName;
  const provider = applied.provider;
  const label = [provider, model].filter(Boolean).join("/") || model || "active Pi model";
  const thinking = applied.thinking ? String(applied.thinking) : undefined;
  const source = applied.modelFallbackReason ? "active" : applied.modelExplicit || applied.thinkingExplicit ? "configured" : "active";
  return {
    model,
    provider,
    api: applied.api,
    thinking,
    requestedModel: applied.requestedModel,
    requestedThinking: applied.requestedThinking,
    effectiveModel: label === "active Pi model" ? undefined : label,
    effectiveThinking: thinking,
    modelFallbackReason: applied.modelFallbackReason,
    thinkingFallbackReason: applied.thinkingFallbackReason,
    fallbackReason: applied.fallbackReason,
    modelExplicit: applied.modelExplicit,
    thinkingExplicit: applied.thinkingExplicit,
    source,
    label,
  };
}

function formatModelSource(materiaModel: MateriaModelSelection | undefined): string {
  if (!materiaModel?.modelExplicit) return "active Pi model fallback";
  if (!materiaModel.modelFallbackReason) return "configured materia setting";
  const requested = materiaModel.requestedModel ? ` \"${materiaModel.requestedModel}\"` : "";
  return `active Pi model fallback (configured model${requested} unavailable: ${materiaModel.modelFallbackReason})`;
}

function formatThinkingSource(materiaModel: MateriaModelSelection | undefined): string {
  if (!materiaModel?.thinkingExplicit) return "active Pi thinking fallback";
  if (!materiaModel.thinkingFallbackReason) return "configured materia setting";
  const requested = materiaModel.requestedThinking ? ` \"${materiaModel.requestedThinking}\"` : "";
  return `safe thinking fallback (configured thinking${requested} unsupported: ${materiaModel.thinkingFallbackReason})`;
}

function contextArtifactPath(state: MateriaCastState, suffix?: string): string {
  const socket = safePathSegment(currentSocketId(state) ?? state.phase);
  const item = state.currentItemKey ? `-${safePathSegment(state.currentItemKey)}` : "";
  const visit = currentSocketVisit(state, 1);
  const extra = suffix ? `-${safePathSegment(suffix)}` : "";
  return path.join("contexts", `${socket}${item}-${visit}${extra}.md`);
}

export async function prepareMultiTurnRefinementTurn(pi: ExtensionAPI, ctx: ExtensionContext, state: MateriaCastState): Promise<void> {
  if (!isPausedMultiTurnRefinement(state)) return;
  const socket = currentSocketOrThrow(state);
  if (!isAgentResolvedSocket(socket)) return;

  const appliedModel = await applyMateriaModelSettings(pi, ctx, { materiaName: resolvedSocketConfig(socket).materia, model: socket.materia.model, thinking: socket.materia.thinking });
  const materiaModel = materiaModelSelection(appliedModel);
  state.currentMateria = socketMateriaName(socket);
  state.currentMateriaModel = materiaModel;
  state.runState.currentMateria = socketMateriaName(socket);
  state.runState.currentMateriaModel = materiaModel;
  state.awaitingResponse = true;
  setCurrentSocketState(state, "awaiting_agent_response");
  state.multiTurnFinalizing = false;
  state.activeTurnPrompt = materiaPrompt(socket.materia, state, [buildSyntheticCastContext(state), multiTurnRefinementGuidance()]);
  state.updatedAt = Date.now();
  const refinementTurn = currentRefinementTurn(state, socket.id) + 1;
  recordUsageModelSelection(state.runState.usage, { socket: socket.id, materia: resolvedSocketConfig(socket).materia, taskId: state.currentItemKey, attempt: state.runState.attempt, materiaModel });
  await writeUsage(state.runState);
  await appendEvent(state.runState, "materia_model_settings", { node: socket.id, materia: resolvedSocketConfig(socket).materia, visit: socketVisit(state, socket.id), itemKey: state.currentItemKey, itemLabel: state.currentItemLabel, itemLabelShort: shortMetadataLabel(state.currentItemLabel), materiaModel, refinementTurn });
  const contextArtifact = await writeContextArtifact(pi, state, buildSyntheticCastContext(state), `refinement-${refinementTurn}-${safeTimestamp()}`);
  await appendManifest(state, { phase: state.phase, node: currentSocketId(state), materia: state.currentMateria, itemKey: state.currentItemKey, visit: socketVisit(state, socket.id), artifact: contextArtifact, kind: "context_refinement", refinementTurn, materiaModel: state.currentMateriaModel });
  await appendEvent(state.runState, "context_refinement", { node: socket.id, materia: socketMateriaName(socket), artifact: contextArtifact, refinementTurn, itemKey: state.currentItemKey, itemLabel: state.currentItemLabel, itemLabelShort: shortMetadataLabel(state.currentItemLabel), materiaModel });
  updateToolScope(pi, socket.materia);
  saveCastState(pi, state);
}

export const nativeTestInternals = {
  applyAdvance,
  applyAssignments,
  applyGenericHandoffEnvelope,
  evaluateCondition,
  renderTemplate,
  resolveValue,
  selectNextTarget,
  setCurrentItem,
  setPath,
};

function socketVisit(state: MateriaCastState, socketId: string): number {
  return state.visits[socketId] ?? 0;
}

/** @deprecated Legacy helper name retained only inside artifact/event compatibility code. */
function currentSocketVisit(state: MateriaCastState, fallback = 0): number {
  const socketId = currentSocketId(state);
  return socketId ? socketVisit(state, socketId) : fallback;
}

function activeResolvedSocket(state: MateriaCastState): ResolvedMateriaSocket | undefined {
  const socketId = currentSocketId(state);
  return socketId ? resolvedPipelineSockets(state)[socketId] : undefined;
}

function currentRefinementTurn(state: MateriaCastState, socketId: string): number {
  return state.multiTurnRefinements?.[refinementIdentityKey(state, socketId)] ?? 0;
}

function nextRefinementTurn(state: MateriaCastState, socketId: string): number {
  state.multiTurnRefinements ??= {};
  const key = refinementIdentityKey(state, socketId);
  const turn = (state.multiTurnRefinements[key] ?? 0) + 1;
  state.multiTurnRefinements[key] = turn;
  return turn;
}

function refinementIdentityKey(state: MateriaCastState, socketId: string): string {
  return JSON.stringify([socketId, state.currentItemKey ?? "__singleton__", socketVisit(state, socketId)]);
}

function taskIdentityKey(state: MateriaCastState, socketId: string): string {
  return JSON.stringify([socketId, state.currentItemKey ?? "__singleton__"]);
}

function startTaskAttempt(state: MateriaCastState, socketId: string): number {
  state.taskAttempts ??= {};
  const key = taskIdentityKey(state, socketId);
  const attempt = (state.taskAttempts[key] ?? 0) + 1;
  state.taskAttempts[key] = attempt;
  return attempt;
}

function currentTaskAttempt(state: MateriaCastState): number | undefined {
  const socketId = currentSocketId(state);
  if (!socketId) return undefined;
  return state.runState.attempt ?? state.taskAttempts?.[taskIdentityKey(state, socketId)];
}

export function loadActiveCastState(ctx: ExtensionContext): MateriaCastState | undefined {
  const entries = ctx.sessionManager.getBranch();
  const seenCastIds = new Set<string>();
  let latest: MateriaCastState | undefined;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== "custom" || entry.customType !== STATE_ENTRY || !entry.data) continue;
    const state = entry.data as MateriaCastState;
    if (!latest) latest = state;
    if (seenCastIds.has(state.castId)) continue;
    seenCastIds.add(state.castId);
    if (state.active) return state;
  }
  return latest;
}

export function saveCastState(pi: ExtensionAPI, state: MateriaCastState): void {
  state.updatedAt = Date.now();
  pi.appendEntry(STATE_ENTRY, state);
}

export function clearCastState(pi: ExtensionAPI, state: MateriaCastState, reason = "aborted"): MateriaCastState {
  state.active = false;
  state.awaitingResponse = false;
  setCurrentSocketState(state, "failed");
  state.phase = reason === "aborted" ? "failed" : state.phase;
  state.failedReason = reason;
  state.updatedAt = Date.now();
  markRunEnded(state);
  saveCastState(pi, state);
  return state;
}

function findLatestAssistantEntry(entries: SessionEntry[], afterId?: string): { entry: SessionEntry; message: unknown } | undefined {
  const afterIndex = afterId ? entries.findIndex((e) => e.id === afterId) : -1;
  for (let i = entries.length - 1; i > afterIndex; i--) {
    const entry = entries[i];
    if (entry.type === "message" && (entry.message as any).role === "assistant") return { entry, message: entry.message };
  }
  return undefined;
}

function assistantText(message: unknown): string {
  const content = (message as any)?.content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => part?.type === "text" ? part.text : "").filter(Boolean).join("\n").trim();
}

function assistantErrorMessage(message: unknown): string | undefined {
  const value = message as { stopReason?: unknown; errorMessage?: unknown };
  if (value.stopReason !== "error") return undefined;
  return typeof value.errorMessage === "string" && value.errorMessage.trim() ? value.errorMessage : "unknown agent error";
}

function agentEndFailureMessage(event: unknown): string | undefined {
  const value = event as { error?: unknown; errorMessage?: unknown; message?: unknown; reason?: unknown; stopReason?: unknown };
  const candidates = [value.errorMessage, value.error, value.message, value.reason].filter((candidate): candidate is string => typeof candidate === "string" && candidate.trim().length > 0);
  if (candidates.length > 0) return candidates.join(": ");
  return value.stopReason === "error" ? "unknown agent error" : undefined;
}

function captureUsage(state: MateriaCastState, message: unknown): void {
  const usage = extractUsage(message);
  if (!usage) return;
  const socket = currentSocketId(state) ?? state.phase;
  const materia = state.currentMateria ?? state.phase;
  addUsage(state.runState.usage, usage, { socket: socket, materia, taskId: state.currentItemKey, attempt: currentTaskAttempt(state), materiaModel: state.currentMateriaModel, messageModel: extractMessageModelInfo(message) });
}

function updateToolScope(pi: ExtensionAPI, materia: MateriaAgentConfig): void {
  const all = pi.getAllTools().map((tool) => tool.name);
  const readOnly = all.filter((name) => ["read", "grep", "find", "ls"].includes(name));
  if (materia.tools === "none") pi.setActiveTools([]);
  else if (materia.tools === "readOnly") pi.setActiveTools(readOnly);
  else pi.setActiveTools(all);
}

export function currentMateria(state: MateriaCastState): MateriaAgentConfig {
  const socket = currentSocketOrThrow(state);
  if (!isAgentResolvedSocket(socket)) throw new Error(`Current Materia socket "${socket.id}" is a utility socket and has no materia.`);
  return socket.materia;
}

export function materiaStatusLabel(state: MateriaCastState, socket?: ResolvedMateriaSocket, options: { suffix?: string; includeItem?: boolean } = {}): string {
  const base = socketMateriaName(socket) ?? state.currentMateria ?? socket?.id ?? currentSocketId(state) ?? state.phase;
  const parts = [base];
  if (options.suffix) parts.push(options.suffix);
  if (options.includeItem !== false && state.currentItemLabel) parts.push(state.currentItemLabel);
  return parts.join(":");
}

function resolvedSocketConfig<TSocket extends ResolvedMateriaSocket>(socket: TSocket): TSocket["socket"] {
  // Compatibility for legacy test/fixture helpers that still construct resolved
  // sockets with `node`; canonical resolved pipelines now materialize `socket` only.
  return (socket.socket ?? (socket as unknown as { node: TSocket["socket"] }).node) as TSocket["socket"];
}

function socketMateriaName(socket: ResolvedMateriaSocket | undefined): string | undefined {
  return socket && isAgentResolvedSocket(socket) ? resolvedSocketConfig(socket).materia : undefined;
}

function isAgentResolvedSocket(socket: ResolvedMateriaSocket): socket is ResolvedMateriaAgentSocket {
  return resolvedSocketConfig(socket).type === "agent";
}

function isMultiTurnResolvedAgentSocket(socket: ResolvedMateriaSocket): socket is ResolvedMateriaAgentSocket {
  return isAgentResolvedSocket(socket) && socket.materia.multiTurn === true;
}

function currentSocketId(state: MateriaCastState): string | undefined {
  // Persisted/plugin DTO compatibility: the saved field is still `currentNode`,
  // but runtime code treats the value as the current socket id.
  return state.currentNode;
}

function setCurrentSocketId(state: MateriaCastState, socketId: string | undefined): void {
  state.currentNode = socketId;
}

function currentSocketState(state: MateriaCastState): MateriaCastState["nodeState"] {
  // Persisted/plugin DTO compatibility: the saved field is still `nodeState`,
  // but runtime code treats the value as the current socket execution state.
  return state.nodeState;
}

function setCurrentSocketState(state: MateriaCastState, socketState: MateriaCastState["nodeState"]): void {
  state.nodeState = socketState;
}

function currentSocketOrThrow(state: MateriaCastState): ResolvedMateriaSocket {
  const socketId = currentSocketId(state);
  const socket = socketId ? resolvedPipelineSockets(state)[socketId] : state.pipeline.entry;
  if (!socket) throw new Error(`Current Materia socket "${socketId}" is not in the resolved grid.`);
  return socket;
}

function resolvedPipelineSockets(state: MateriaCastState): Record<string, ResolvedMateriaSocket> {
  // Compatibility for persisted/fixture state snapshots that predate resolved
  // pipeline socket materialization. Runtime-created pipelines use `sockets`.
  return state.pipeline.sockets ?? (state.pipeline as unknown as { nodes?: Record<string, ResolvedMateriaSocket> }).nodes ?? {};
}

async function writeManifest(runDir: string, manifest: MateriaManifest): Promise<void> {
  await writeFile(path.join(runDir, MANIFEST_FILE), JSON.stringify(manifest, null, 2));
}

async function appendManifest(state: MateriaCastState, entry: Omit<MateriaManifestEntry, "timestamp">): Promise<void> {
  const file = path.join(state.runDir, MANIFEST_FILE);
  let manifest: MateriaManifest;
  try {
    manifest = JSON.parse(await readFile(file, "utf8")) as MateriaManifest;
  } catch {
    manifest = { castId: state.castId, request: state.request, configSource: state.configSource, entries: [] };
  }
  const itemLabel = entry.itemLabel ?? (entry.itemKey && entry.itemKey === state.currentItemKey ? state.currentItemLabel : undefined);
  manifest.entries.push({
    ...entry,
    itemLabel,
    itemLabelShort: entry.itemLabelShort ?? shortMetadataLabel(itemLabel),
    timestamp: Date.now(),
  });
  await writeManifest(state.runDir, manifest);
}

function shortMetadataLabel(label: unknown): string | undefined {
  if (typeof label !== "string") return undefined;
  const normalized = label.replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  if (normalized.length <= MAX_METADATA_ITEM_LABEL_LENGTH) return normalized;
  return `${normalized.slice(0, MAX_METADATA_ITEM_LABEL_LENGTH - 1)}…`;
}

async function loadConfigFromState(state: MateriaCastState): Promise<PiMateriaConfig> {
  return JSON.parse(await readFile(path.join(state.runDir, "config.resolved.json"), "utf8")) as PiMateriaConfig;
}

function hashConfig(config: PiMateriaConfig): string {
  const value = JSON.stringify(config);
  let hash = 0;
  for (let i = 0; i < value.length; i++) hash = Math.imul(31, hash) + value.charCodeAt(i) | 0;
  return (hash >>> 0).toString(16);
}
