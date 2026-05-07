import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@mariozechner/pi-coding-agent";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { appendEvent, safePathSegment, safeTimestamp } from "./artifacts.js";
import { resolveProactiveCompactionThreshold } from "./compaction.js";
import { resolveArtifactRoot } from "./config.js";
import { getEffectivePipelineConfig, loopIteratorForNode } from "./pipeline.js";
import { parseJson } from "./json.js";
import { canonicalOutgoingEdges } from "./graphValidation.js";
import { HANDOFF_CONTRACT_PROMPT_TEXT, HANDOFF_SATISFIED_FIELD } from "./handoffContract.js";
import { validateHandoffJsonOutput } from "./handoffValidation.js";
import { applyMateriaModelSettings } from "./modelSettings.js";
import type { AppliedMateriaModelSettings } from "./modelSettings.js";
import type { LoadedConfig, MateriaAgentConfig, MateriaCastState, MateriaEdgeConfig, MateriaManifest, MateriaManifestEntry, PiMateriaConfig, ResolvedMateriaAgentNode, ResolvedMateriaNode, ResolvedMateriaPipeline, MateriaModelSelection } from "./types.js";
import { formatUsage, showUsageSummary, updateWidget } from "./ui.js";
import { addUsage, assertBudget, createRunState, extractMessageModelInfo, extractUsage, recordUsageModelSelection, writeUsage } from "./usage.js";
import { executeBuiltInUtility, hasBuiltInUtility, type BuiltInUtilityInput } from "./utilityRegistry.js";

const STATE_ENTRY = "pi-materia-cast-state";
const MANIFEST_FILE = "manifest.json";
const DEFAULT_MAX_NODE_VISITS = 25;
const DEFAULT_MAX_EDGE_TRAVERSALS = 25;
const DEFAULT_UTILITY_TIMEOUT_MS = 30_000;
const MAX_UTILITY_OUTPUT_BYTES = 1024 * 1024;
const MAX_UTILITY_ERROR_SUMMARY_LENGTH = 800;
const MAX_METADATA_ITEM_LABEL_LENGTH = 80;
const DEFAULT_MAX_SAME_NODE_RECOVERY_ATTEMPTS = 1;

export { defaultProactiveCompactionThresholdPercent } from "./compaction.js";

export async function startNativeCast(pi: ExtensionAPI, ctx: ExtensionContext, loaded: LoadedConfig, pipeline: ResolvedMateriaPipeline, request: string): Promise<void> {
  const config = loaded.config;
  const artifactRoot = resolveArtifactRoot(ctx.cwd, config.artifactDir);
  const castId = safeTimestamp();
  const runDir = path.join(artifactRoot, castId);
  await mkdir(path.join(runDir, "nodes"), { recursive: true });
  await mkdir(path.join(runDir, "contexts"), { recursive: true });
  await writeFile(path.join(runDir, "config.resolved.json"), JSON.stringify(config, null, 2));

  const runState = createRunState(castId, runDir, ctx.model);
  runState.currentNode = pipeline.entry.id;
  runState.currentMateria = nodeMateriaName(pipeline.entry);
  runState.lastMessage = pipeline.entry.id;
  await writeUsage(runState);
  const effectivePipeline = getEffectivePipelineConfig(config);
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
    currentMateria: nodeMateriaName(pipeline.entry),
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
  updateWidget(ctx, state.runState);
  ctx.ui.notify(`pi-materia cast started. Artifacts: ${runDir}`, "info");
  await startNode(pi, ctx, state, pipeline.entry);
}

export async function continueNativeCast(pi: ExtensionAPI, ctx: ExtensionContext, state: MateriaCastState): Promise<void> {
  if (!state.active) throw new Error("No active pi-materia cast to continue.");
  if (state.awaitingResponse) throw new Error("Materia is already awaiting a Pi agent response.");

  if (state.nodeState === "awaiting_user_refinement") {
    if (!isPausedMultiTurnRefinement(state)) {
      throw new Error("Materia is awaiting user refinement, but the current node's resolved materia is not multi-turn.");
    }
    await startMultiTurnFinalizationTurn(pi, ctx, state);
    return;
  }

  await startNode(pi, ctx, state, currentNodeOrThrow(state));
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
  return listLatestCastStates(ctx).filter((state) => !state.active && state.phase !== "complete" && state.nodeState !== "complete" && (state.phase === "failed" || state.nodeState === "failed"));
}

export async function resumeNativeCast(pi: ExtensionAPI, ctx: ExtensionContext, castId: string): Promise<MateriaCastState> {
  const state = loadCastStateById(ctx, castId);
  if (!state) throw new Error(`Unknown pi-materia cast id "${castId}" in this session.`);
  const active = loadActiveCastState(ctx);
  if (active?.active) {
    if (active.castId === state.castId) throw new Error(`pi-materia cast ${state.castId} is already running.`);
    throw new Error(`A pi-materia cast is already active (${active.castId}). Abort it before recasting ${state.castId}.`);
  }
  if (state.active) throw new Error(`pi-materia cast ${state.castId} is already running.`);
  if (state.phase === "complete" || state.nodeState === "complete") throw new Error(`pi-materia cast ${state.castId} is complete and cannot be recast.`);
  if (state.phase !== "failed" && state.nodeState !== "failed") throw new Error(`pi-materia cast ${state.castId} is not failed or aborted (phase: ${state.phase}, node state: ${state.nodeState ?? "unknown"}).`);
  const node = currentNodeOrThrow(state);
  const previousFailure = state.failedReason;

  state.active = true;
  state.phase = node.id;
  state.currentNode = node.id;
  state.currentMateria = nodeMateriaName(node);
  state.awaitingResponse = isAgentResolvedNode(node);
  state.nodeState = isAgentResolvedNode(node) ? "awaiting_agent_response" : "running_utility";
  state.failedReason = undefined;
  state.runState.currentNode = node.id;
  state.runState.currentMateria = nodeMateriaName(node);
  state.runState.lastMessage = `Recasting from node ${node.id}.`;
  await appendEvent(state.runState, "cast_recast", { node: node.id, materia: nodeMateriaName(node), type: node.node.type, previousFailure, itemKey: state.currentItemKey, itemLabel: state.currentItemLabel, itemLabelShort: shortMetadataLabel(state.currentItemLabel), visit: nodeVisit(state, node.id), reusedActivePrompt: isAgentResolvedNode(node) && Boolean(state.activeTurnPrompt) });
  await writeUsage(state.runState);
  saveCastState(pi, state);
  ctx.ui.setStatus("materia", state.currentItemLabel ? `${node.id}:${state.currentItemLabel}` : node.id);
  updateWidget(ctx, state.runState);

  if (isAgentResolvedNode(node) && state.activeTurnPrompt) {
    updateToolScope(pi, node.materia);
    await sendMateriaTurn(pi, ctx, state, state.activeTurnPrompt);
  } else {
    await startNode(pi, ctx, state, node);
  }
  ctx.ui.notify(`pi-materia cast ${state.castId} recast from node "${node.id}".`, "info");
  return state;
}

async function startMultiTurnFinalizationTurn(pi: ExtensionAPI, ctx: ExtensionContext, state: MateriaCastState): Promise<void> {
  const node = currentNodeOrThrow(state);
  if (!isMultiTurnResolvedAgentNode(node)) {
    throw new Error(`Cannot finalize refinement for node "${node.id}" because its resolved materia is not multi-turn.`);
  }
  const appliedModel = await applyMateriaModelSettings(pi, ctx, { materiaName: node.node.materia, model: node.materia.model, thinking: node.materia.thinking });
  const materiaModel = materiaModelSelection(appliedModel);
  state.currentMateria = nodeMateriaName(node);
  state.currentMateriaModel = materiaModel;
  state.runState.currentMateria = nodeMateriaName(node);
  state.runState.currentMateriaModel = materiaModel;
  state.awaitingResponse = true;
  state.nodeState = "awaiting_agent_response";
  state.multiTurnFinalizing = true;
  state.updatedAt = Date.now();
  const refinementTurn = currentRefinementTurn(state, node.id) + 1;
  recordUsageModelSelection(state.runState.usage, { node: node.id, materia: node.node.materia, taskId: state.currentItemKey, attempt: state.runState.attempt, materiaModel });
  await writeUsage(state.runState);
  await appendEvent(state.runState, "materia_model_settings", { node: node.id, materia: node.node.materia, visit: nodeVisit(state, node.id), itemKey: state.currentItemKey, itemLabel: state.currentItemLabel, itemLabelShort: shortMetadataLabel(state.currentItemLabel), materiaModel, refinementTurn, finalization: true });
  updateToolScope(pi, node.materia);
  saveCastState(pi, state);
  await sendMateriaTurn(pi, ctx, state, buildMultiTurnFinalizationPrompt(state, node));
}

export async function handleAgentEnd(pi: ExtensionAPI, event: { messages: unknown[] }, ctx: ExtensionContext): Promise<void> {
  const state = loadActiveCastState(ctx);
  if (!state?.active) return;
  const nodeAtEnd = currentNodeOrThrow(state);
  const acceptingRefinement = !state.awaitingResponse && state.nodeState === "awaiting_user_refinement" && isMultiTurnResolvedAgentNode(nodeAtEnd);
  if (!state.awaitingResponse && !acceptingRefinement) return;

  const latest = findLatestAssistantEntry(ctx.sessionManager.getEntries(), state.lastProcessedEntryId);
  if (!latest || latest.entry.id === state.lastProcessedEntryId) {
    const eventFailure = agentEndFailureMessage(event);
    if (!eventFailure) return;
    const error = new Error(`Pi agent turn failed before producing an assistant response for node "${state.currentNode ?? state.phase}": ${eventFailure}`);
    const recovered = await handleSameNodeRecoverableTurnFailure(pi, ctx, state, error);
    if (!recovered) await failCast(pi, ctx, state, nonRecoverableTurnError(state, error));
    return;
  }

  const text = assistantText(latest.message);
  const agentError = assistantErrorMessage(latest.message);
  const wasAwaitingFinalization = state.awaitingResponse && state.nodeState === "awaiting_agent_response" && state.multiTurnFinalizing === true;
  state.lastProcessedEntryId = latest.entry.id;
  state.lastAssistantText = text;
  captureUsage(state, latest.message);

  if (agentError) {
    const error = new Error(`Pi agent turn failed for node "${state.currentNode ?? state.phase}": ${agentError}`);
    const recovered = await handleSameNodeRecoverableTurnFailure(pi, ctx, state, error, { entryId: latest.entry.id });
    if (!recovered) await failCast(pi, ctx, state, nonRecoverableTurnError(state, error), latest.entry.id);
    return;
  }

  state.awaitingResponse = false;
  state.nodeState = "idle";
  state.updatedAt = Date.now();

  try {
    const node = currentNodeOrThrow(state);
    // Multi-turn pausing is materia-driven: if the resolved agent materia omits
    // multiTurn, even an interactive planning node completes and advances.
    // Keep this generic runtime gate materia-name agnostic.
    if (isMultiTurnResolvedAgentNode(node)) {
      if (wasAwaitingFinalization) {
        state.multiTurnFinalizing = false;
        state.nodeState = "idle";
        saveCastState(pi, state);
        await completeNode(pi, ctx, state, text, latest.entry.id, { finalizedMultiTurn: true });
        return;
      }
      state.multiTurnFinalizing = false;
      const refinement = await recordMultiTurnRefinement(state, node, text, latest.entry.id);
      state.nodeState = "awaiting_user_refinement";
      state.runState.lastMessage = `Multi-turn node ${node.id} waiting for refinement; run /materia continue to finalize.`;
      await writeUsage(state.runState);
      await appendEvent(state.runState, "node_refinement", { node: node.id, materia: nodeMateriaName(node), type: node.node.type, artifact: refinement.artifact, entryId: latest.entry.id, refinementTurn: refinement.turn, itemKey: state.currentItemKey, itemLabel: state.currentItemLabel, itemLabelShort: shortMetadataLabel(state.currentItemLabel), materiaModel: state.currentMateriaModel });
      saveCastState(pi, state);
      ctx.ui.setStatus("materia", `${node.id}:refine`);
      updateWidget(ctx, state.runState);
      ctx.ui.notify(`pi-materia multi-turn node "${node.id}" is waiting for refinement; run /materia continue to finalize.`, "info");
      return;
    }
    await completeNode(pi, ctx, state, text, latest.entry.id);
  } catch (error) {
    state.active = false;
    state.phase = "failed";
    state.nodeState = "failed";
    state.failedReason = error instanceof Error ? error.message : String(error);
    state.runState.lastMessage = state.failedReason;
    await appendEvent(state.runState, "cast_end", { ok: false, error: state.failedReason });
    await writeUsage(state.runState);
    await appendManifest(state, { phase: "failed", entryId: latest.entry.id });
    saveCastState(pi, state);
    ctx.ui.setStatus("materia", "failed");
    updateWidget(ctx, state.runState);
    ctx.ui.notify(`pi-materia cast failed: ${state.failedReason}`, "error");
  }
}

async function completeNode(pi: ExtensionAPI, ctx: ExtensionContext, state: MateriaCastState, text: string, entryId: string, options: { finalizedMultiTurn?: boolean } = {}): Promise<void> {
  const config = await loadConfigFromState(state);
  const node = currentNodeOrThrow(state);
  if (isMultiTurnResolvedAgentNode(node) && !options.finalizedMultiTurn) {
    throw new Error(`Internal multi-turn state error for node "${node.id}": completion requires explicit /materia continue finalization.`);
  }
  const artifact = await recordNodeOutput(state, node, text, entryId);
  state.lastOutput = text;

  let parsed: unknown = text;
  if (node.node.parse === "json") {
    try {
      parsed = parseJson<unknown>(text);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid JSON output for node "${node.id}": ${detail}`);
    }
    parsed = validateHandoffJsonOutput(parsed, { nodeId: node.id, node: node.node });
    state.lastJson = parsed;
    await writeFile(path.join(state.runDir, "nodes", safePathSegment(node.id), `${nodeVisit(state, node.id)}.json`), JSON.stringify(parsed, null, 2));
  }

  applyAssignments(state, node, parsed);
  const advanceTarget = applyAdvance(state, node, parsed);
  const finalizedRefinement = isMultiTurnResolvedAgentNode(node);
  await appendEvent(state.runState, "node_complete", { node: node.id, materia: nodeMateriaName(node), type: node.node.type, artifact, parsed: node.node.parse === "json", entryId, finalizedRefinement: finalizedRefinement || undefined, refinementTurn: finalizedRefinement ? currentRefinementTurn(state, node.id) : undefined, itemKey: state.currentItemKey, itemLabel: state.currentItemLabel, itemLabelShort: shortMetadataLabel(state.currentItemLabel), materiaModel: state.currentMateriaModel });
  await assertBudget(config, state.runState, ctx);

  const nextTarget = advanceTarget ?? selectNextTarget(state, node, parsed, config);
  await advanceToNode(pi, ctx, state, nextTarget, entryId);
}

async function recordNodeOutput(state: MateriaCastState, node: ResolvedMateriaNode, text: string, entryId: string): Promise<string> {
  const visit = nodeVisit(state, node.id);
  const dir = path.join("nodes", safePathSegment(node.id));
  const item = state.currentItemKey ? `-${safePathSegment(state.currentItemKey)}` : "";
  const artifact = path.join(dir, `${visit}${item}.md`);
  await mkdir(path.dirname(path.join(state.runDir, artifact)), { recursive: true });
  await writeFile(path.join(state.runDir, artifact), text);
  const finalizedRefinement = isMultiTurnResolvedAgentNode(node);
  await appendManifest(state, { phase: state.phase, node: node.id, materia: nodeMateriaName(node), itemKey: state.currentItemKey, visit, entryId, artifact, kind: "node_output", finalized: finalizedRefinement || undefined, refinementTurn: finalizedRefinement ? currentRefinementTurn(state, node.id) : undefined, materiaModel: state.currentMateriaModel });
  return artifact;
}

async function recordMultiTurnRefinement(state: MateriaCastState, node: ResolvedMateriaNode, text: string, entryId: string): Promise<{ artifact: string; turn: number }> {
  const visit = nodeVisit(state, node.id);
  const turn = nextRefinementTurn(state, node.id);
  const dir = path.join("nodes", safePathSegment(node.id));
  const item = state.currentItemKey ? `-${safePathSegment(state.currentItemKey)}` : "";
  const artifact = path.join(dir, `${visit}${item}.refinement-${turn}-${safePathSegment(entryId)}.md`);
  await mkdir(path.dirname(path.join(state.runDir, artifact)), { recursive: true });
  await writeFile(path.join(state.runDir, artifact), text);
  await appendManifest(state, { phase: state.phase, node: node.id, materia: nodeMateriaName(node), itemKey: state.currentItemKey, visit, entryId, artifact, kind: "node_refinement", refinementTurn: turn, materiaModel: state.currentMateriaModel });
  return { artifact, turn };
}

function applyAssignments(state: MateriaCastState, node: ResolvedMateriaNode, parsed: unknown): void {
  for (const [target, source] of Object.entries(node.node.assign ?? {})) {
    setPath(state.data, target, resolveValue(source, state, parsed));
  }
}

function applyAdvance(state: MateriaCastState, node: ResolvedMateriaNode, parsed: unknown): string | undefined {
  const advance = node.node.advance;
  if (!advance) return undefined;
  if (advance.when && !evaluateCondition(advance.when, state, parsed)) return undefined;
  const items = asArray(resolveValue(advance.items, state));
  const next = (state.cursors[advance.cursor] ?? 0) + 1;
  state.cursors[advance.cursor] = next;
  state.currentItemKey = undefined;
  state.currentItemLabel = undefined;
  return next >= items.length ? advance.done : undefined;
}

function selectNextTarget(state: MateriaCastState, node: ResolvedMateriaNode, parsed: unknown, config: PiMateriaConfig): string {
  for (const edge of canonicalOutgoingEdges(node.node)) {
    if (evaluateEdgeCondition(edge.when, state, parsed)) {
      enforceEdgeLimit(state, node.id, edge, config);
      return edge.to;
    }
  }
  return "end";
}

function enforceEdgeLimit(state: MateriaCastState, from: string, edge: MateriaEdgeConfig, config: PiMateriaConfig): void {
  const key = `${from}->${edge.to}`;
  const count = (state.edgeTraversals[key] ?? 0) + 1;
  state.edgeTraversals[key] = count;
  const limit = edge.maxTraversals ?? config.limits?.maxEdgeTraversals ?? DEFAULT_MAX_EDGE_TRAVERSALS;
  if (count > limit) throw new Error(`Materia edge traversal limit exceeded for ${key} (${count}/${limit}).`);
}

async function advanceToNode(pi: ExtensionAPI, ctx: ExtensionContext, state: MateriaCastState, targetId: string | undefined, entryId: string): Promise<void> {
  const target = targetId ?? "end";
  if (target === "end") return await finishCast(pi, ctx, state, entryId, "Cast complete.");
  const node = state.pipeline.nodes[target];
  if (!node) throw new Error(`Unknown graph target "${target}"`);
  await startNode(pi, ctx, state, node);
}

async function startNode(pi: ExtensionAPI, ctx: ExtensionContext, state: MateriaCastState, node: ResolvedMateriaNode): Promise<void> {
  const config = await loadConfigFromState(state);
  const hasItem = setCurrentItem(state, node);
  const loop = loopIteratorForNode(state.pipeline, node.id);
  if (loop && !hasItem) return await advanceToNode(pi, ctx, state, loop.done ?? "end", "foreach-empty");
  enforceNodeLimit(state, node, config);
  const attempt = startTaskAttempt(state, node.id);

  state.phase = node.id;
  state.currentNode = node.id;
  state.currentMateria = nodeMateriaName(node);
  state.currentMateriaModel = undefined;
  state.awaitingResponse = true;
  state.nodeState = isAgentResolvedNode(node) ? "awaiting_agent_response" : "running_utility";
  state.updatedAt = Date.now();
  state.runState.currentNode = node.id;
  state.runState.currentMateria = nodeMateriaName(node);
  state.runState.currentMateriaModel = undefined;
  state.runState.currentTask = state.currentItemLabel;
  state.runState.attempt = attempt;
  state.runState.lastMessage = node.id;
  await writeUsage(state.runState);
  await appendEvent(state.runState, "node_start", { node: node.id, materia: nodeMateriaName(node), type: node.node.type, itemKey: state.currentItemKey, itemLabel: state.currentItemLabel, itemLabelShort: shortMetadataLabel(state.currentItemLabel), visit: nodeVisit(state, node.id) });
  saveCastState(pi, state);
  updateWidget(ctx, state.runState);
  ctx.ui.setStatus("materia", state.currentItemLabel ? `${node.id}:${state.currentItemLabel}` : node.id);

  if (!isAgentResolvedNode(node)) {
    state.awaitingResponse = false;
    state.nodeState = "running_utility";
    state.currentMateria = undefined;
    state.currentMateriaModel = undefined;
    state.runState.currentMateria = undefined;
    state.runState.currentMateriaModel = undefined;
    saveCastState(pi, state);
    try {
      const result = await executeUtilityNode(state, node);
      await completeNode(pi, ctx, state, result.output, result.entryId);
    } catch (error) {
      await failCast(pi, ctx, state, error, `utility:${node.id}:${nodeVisit(state, node.id)}`);
    }
    return;
  }

  state.awaitingResponse = true;
  state.nodeState = "awaiting_agent_response";
  saveCastState(pi, state);
  const appliedModel = await applyMateriaModelSettings(pi, ctx, { materiaName: node.node.materia, model: node.materia.model, thinking: node.materia.thinking });
  const materiaModel = materiaModelSelection(appliedModel);
  state.currentMateriaModel = materiaModel;
  state.runState.currentMateriaModel = materiaModel;
  recordUsageModelSelection(state.runState.usage, { node: node.id, materia: node.node.materia, taskId: state.currentItemKey, attempt: state.runState.attempt, materiaModel });
  await writeUsage(state.runState);
  await appendEvent(state.runState, "materia_model_settings", { node: node.id, materia: node.node.materia, visit: nodeVisit(state, node.id), itemKey: state.currentItemKey, itemLabel: state.currentItemLabel, itemLabelShort: shortMetadataLabel(state.currentItemLabel), materiaModel });
  saveCastState(pi, state);
  updateToolScope(pi, node.materia);
  await sendMateriaTurn(pi, ctx, state, buildNodePrompt(state, node));
}

async function executeUtilityNode(state: MateriaCastState, node: Extract<ResolvedMateriaNode, { node: { type: "utility" } }>): Promise<{ output: string; entryId: string }> {
  const visit = nodeVisit(state, node.id);
  const input = buildUtilityInput(state, node);
  const inputArtifact = await recordUtilityInput(state, node, input);
  await appendEvent(state.runState, "utility_input", { node: node.id, artifact: inputArtifact, itemKey: state.currentItemKey, itemLabel: state.currentItemLabel, itemLabelShort: shortMetadataLabel(state.currentItemLabel), visit });

  const params = node.node.params ?? {};
  let output: string;
  if (node.node.command) {
    output = await executeCommandUtility(state, node, input);
  } else if (Object.prototype.hasOwnProperty.call(params, "output")) {
    const value = params.output;
    output = typeof value === "string" ? value : JSON.stringify(value);
  } else if (hasBuiltInUtility(node.node.utility)) {
    output = await executeBuiltInUtility(node.node.utility, input as BuiltInUtilityInput);
  } else {
    throw new Error(`Unknown utility alias "${node.node.utility}" for node "${node.id}".`);
  }

  return { output, entryId: `utility:${node.id}:${visit}` };
}

async function executeCommandUtility(state: MateriaCastState, node: Extract<ResolvedMateriaNode, { node: { type: "utility" } }>, input: Record<string, unknown>): Promise<string> {
  const command = node.node.command;
  if (!command || command.length === 0) throw new Error(`Utility node "${node.id}" has no explicit command configured.`);

  const timeoutMs = node.node.timeoutMs ?? DEFAULT_UTILITY_TIMEOUT_MS;
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
  const artifacts = await recordCommandArtifacts(state, node, stdoutText, stderrText, stdout.truncated, stderr.truncated);
  await appendEvent(state.runState, "utility_command", { node: node.id, command, code: result.code, signal: result.signal, timedOut, timeoutMs, stdoutArtifact: artifacts.stdoutArtifact, stderrArtifact: artifacts.stderrArtifact, stdoutTruncated: stdout.truncated, stderrTruncated: stderr.truncated });

  if (timedOut) {
    throw new Error(`Utility command timed out for node "${node.id}" after ${timeoutMs}ms: ${formatCommandForError(command)}. stdout: ${artifacts.stdoutArtifact}; stderr: ${artifacts.stderrArtifact}`);
  }
  if (result.code !== 0) {
    const summary = summarizeStderr(stderrText, stderr.truncated);
    throw new Error(`Utility command failed for node "${node.id}": ${formatCommandForError(command)} exited with code ${result.code ?? `signal ${result.signal ?? "unknown"}`}. stderr: ${summary}. stdout: ${artifacts.stdoutArtifact}; stderr: ${artifacts.stderrArtifact}`);
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

async function recordCommandArtifacts(state: MateriaCastState, node: ResolvedMateriaNode, stdout: string, stderr: string, stdoutTruncated: boolean, stderrTruncated: boolean): Promise<{ stdoutArtifact: string; stderrArtifact: string; metaArtifact: string }> {
  const visit = nodeVisit(state, node.id);
  const dir = path.join("nodes", safePathSegment(node.id));
  const item = state.currentItemKey ? `-${safePathSegment(state.currentItemKey)}` : "";
  const stdoutArtifact = path.join(dir, `${visit}${item}.command.stdout.txt`);
  const stderrArtifact = path.join(dir, `${visit}${item}.command.stderr.txt`);
  const metaArtifact = path.join(dir, `${visit}${item}.command.json`);
  await mkdir(path.dirname(path.join(state.runDir, stdoutArtifact)), { recursive: true });
  await writeFile(path.join(state.runDir, stdoutArtifact), stdout);
  await writeFile(path.join(state.runDir, stderrArtifact), stderr);
  await writeFile(path.join(state.runDir, metaArtifact), JSON.stringify({ stdoutArtifact, stderrArtifact, stdoutTruncated, stderrTruncated, maxBytes: MAX_UTILITY_OUTPUT_BYTES }, null, 2));
  await appendManifest(state, { phase: state.phase, node: node.id, materia: nodeMateriaName(node), itemKey: state.currentItemKey, visit, entryId: `utility:${node.id}:${visit}:command:stdout`, artifact: stdoutArtifact });
  await appendManifest(state, { phase: state.phase, node: node.id, materia: nodeMateriaName(node), itemKey: state.currentItemKey, visit, entryId: `utility:${node.id}:${visit}:command:stderr`, artifact: stderrArtifact });
  await appendManifest(state, { phase: state.phase, node: node.id, materia: nodeMateriaName(node), itemKey: state.currentItemKey, visit, entryId: `utility:${node.id}:${visit}:command:meta`, artifact: metaArtifact });
  return { stdoutArtifact, stderrArtifact, metaArtifact };
}

function summarizeStderr(stderr: string, truncated: boolean): string {
  const summary = stderr.trim().replace(/\s+/g, " ").slice(0, MAX_UTILITY_ERROR_SUMMARY_LENGTH);
  return `${summary || "<empty>"}${truncated ? " (truncated)" : ""}`;
}

function formatCommandForError(command: string[]): string {
  return command.map((part) => JSON.stringify(part)).join(" ");
}

function buildUtilityInput(state: MateriaCastState, node: Extract<ResolvedMateriaNode, { node: { type: "utility" } }>): Record<string, unknown> {
  const loop = node.node.foreach ?? loopIteratorForNode(state.pipeline, node.id);
  const cursorName = loop?.cursor ?? (loop ? `${node.id}Index` : undefined);
  return {
    cwd: state.cwd,
    runDir: state.runDir,
    request: state.request,
    castId: state.castId,
    nodeId: node.id,
    params: node.node.params ?? {},
    state: state.data,
    item: currentItem(state) ?? null,
    itemKey: state.currentItemKey ?? null,
    itemLabel: state.currentItemLabel ?? null,
    cursor: cursorName ? { name: cursorName, index: state.cursors[cursorName] ?? 0 } : null,
    cursors: state.cursors,
  };
}

async function recordUtilityInput(state: MateriaCastState, node: ResolvedMateriaNode, input: Record<string, unknown>): Promise<string> {
  const visit = nodeVisit(state, node.id);
  const dir = path.join("nodes", safePathSegment(node.id));
  const item = state.currentItemKey ? `-${safePathSegment(state.currentItemKey)}` : "";
  const artifact = path.join(dir, `${visit}${item}.input.json`);
  await mkdir(path.dirname(path.join(state.runDir, artifact)), { recursive: true });
  await writeFile(path.join(state.runDir, artifact), JSON.stringify(input, null, 2));
  await appendManifest(state, { phase: state.phase, node: node.id, materia: nodeMateriaName(node), itemKey: state.currentItemKey, visit, entryId: `utility:${node.id}:${visit}:input`, artifact });
  return artifact;
}

async function handleSameNodeRecoverableTurnFailure(pi: ExtensionAPI, ctx: ExtensionContext, state: MateriaCastState, error: unknown, options: { entryId?: string } = {}): Promise<boolean> {
  const reason = classifyRecoverableTurnFailure(error);
  if (!reason) {
    return false;
  }

  const key = recoveryIdentityKey(state);
  state.recoveryAttempts ??= {};
  const previousAttempts = state.recoveryAttempts[key] ?? 0;
  const maxAttempts = DEFAULT_MAX_SAME_NODE_RECOVERY_ATTEMPTS;
  if (previousAttempts >= maxAttempts) {
    const exhausted = `Same-node recovery exhausted for ${recoveryDiagnosticLabel(state)} after ${previousAttempts}/${maxAttempts} attempt(s): ${errorMessage(error)}`;
    await appendEvent(state.runState, "same_node_recovery_exhausted", { reason, key, attempts: previousAttempts, maxAttempts, error: errorMessage(error), entryId: options.entryId, node: state.currentNode, itemKey: state.currentItemKey, mode: recoveryTurnMode(state) });
    await failCast(pi, ctx, state, new Error(exhausted), options.entryId);
    return true;
  }

  const attempt = previousAttempts + 1;
  state.recoveryAttempts[key] = attempt;
  state.awaitingResponse = true;
  state.nodeState = "awaiting_agent_response";
  state.updatedAt = Date.now();
  state.runState.lastMessage = `Retrying ${recoveryDiagnosticLabel(state)} after recoverable ${reason} failure (${attempt}/${maxAttempts}).`;
  await appendEvent(state.runState, "same_node_recovery_start", { reason, key, attempt, maxAttempts, error: errorMessage(error), entryId: options.entryId, node: state.currentNode, itemKey: state.currentItemKey, itemLabel: state.currentItemLabel, itemLabelShort: shortMetadataLabel(state.currentItemLabel), visit: state.currentNode ? nodeVisit(state, state.currentNode) : undefined, mode: recoveryTurnMode(state) });
  await writeUsage(state.runState);
  saveCastState(pi, state);

  try {
    if (reason === "context_window") await runSameNodeRecoveryAction(pi, ctx, state, { action: "compact", reason, key, attempt, maxAttempts, entryId: options.entryId });
    updateToolScope(pi, currentMateria(state));
    await sendMateriaTurn(pi, ctx, state, buildSameNodeRecoveryPrompt(state), { skipProactiveCompaction: true });
    await appendEvent(state.runState, "same_node_recovery_retry", { reason, key, attempt, maxAttempts, node: state.currentNode, itemKey: state.currentItemKey, mode: recoveryTurnMode(state) });
    saveCastState(pi, state);
    updateWidget(ctx, state.runState);
    ctx.ui.notify(`pi-materia retrying ${recoveryDiagnosticLabel(state)} after recoverable ${reason} failure (${attempt}/${maxAttempts}).`, "warning");
    return true;
  } catch (retryError) {
    await appendEvent(state.runState, "same_node_recovery_retry_failed", { reason, key, attempt, maxAttempts, error: errorMessage(retryError), originalError: errorMessage(error), entryId: options.entryId, node: state.currentNode, itemKey: state.currentItemKey, mode: recoveryTurnMode(state) });
    await failCast(pi, ctx, state, new Error(`Same-node recovery retry failed for ${recoveryDiagnosticLabel(state)}: ${errorMessage(retryError)}. Original failure: ${errorMessage(error)}`), options.entryId);
    return true;
  }
}

async function runSameNodeRecoveryAction(pi: ExtensionAPI, ctx: ExtensionContext, state: MateriaCastState, options: { action: "compact"; reason: "context_window"; key: string; attempt: number; maxAttempts: number; entryId?: string }): Promise<void> {
  await appendEvent(state.runState, "same_node_recovery_action_start", { action: options.action, reason: options.reason, key: options.key, attempt: options.attempt, maxAttempts: options.maxAttempts, entryId: options.entryId, node: state.currentNode, itemKey: state.currentItemKey, mode: recoveryTurnMode(state) });
  saveCastState(pi, state);

  try {
    const result = await forceContextCompaction(ctx, state);
    await appendEvent(state.runState, "same_node_recovery_action_complete", { action: options.action, reason: options.reason, key: options.key, attempt: options.attempt, maxAttempts: options.maxAttempts, entryId: options.entryId, node: state.currentNode, itemKey: state.currentItemKey, mode: recoveryTurnMode(state), result: summarizeCompactionResult(result) });
    saveCastState(pi, state);
  } catch (actionError) {
    await appendEvent(state.runState, "same_node_recovery_action_failed", { action: options.action, reason: options.reason, key: options.key, attempt: options.attempt, maxAttempts: options.maxAttempts, entryId: options.entryId, node: state.currentNode, itemKey: state.currentItemKey, mode: recoveryTurnMode(state), error: errorMessage(actionError) });
    throw new Error(`Same-node recovery action compact failed for ${recoveryDiagnosticLabel(state)}: ${errorMessage(actionError)}`);
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
    node: state.currentNode,
    itemKey: state.currentItemKey,
    itemLabel: state.currentItemLabel,
    itemLabelShort: shortMetadataLabel(state.currentItemLabel),
    visit: state.currentNode ? nodeVisit(state, state.currentNode) : undefined,
    mode: recoveryTurnMode(state),
  };
  await appendEvent(state.runState, "proactive_compaction_start", eventBase);
  saveCastState(pi, state);

  try {
    const result = await compactContext(ctx, `Pi Materia proactive context-pressure compaction before ${recoveryDiagnosticLabel(state)}. Preserve the active cast state, task requirements, and any durable artifacts/events needed to continue the same turn.`);
    await appendEvent(state.runState, "proactive_compaction_complete", { ...eventBase, result: summarizeCompactionResult(result) });
    saveCastState(pi, state);
  } catch (error) {
    const message = `Proactive compaction failed before ${recoveryDiagnosticLabel(state)}; continuing turn so same-node recovery can handle any later context-window failure: ${errorMessage(error)}`;
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

function buildSameNodeRecoveryPrompt(state: MateriaCastState): string {
  if (state.activeTurnPrompt) return state.activeTurnPrompt;
  const node = currentNodeOrThrow(state);
  if (recoveryTurnMode(state) === "finalization") return buildMultiTurnFinalizationPrompt(state, node);
  return buildNodePrompt(state, node);
}

function recoveryTurnMode(state: MateriaCastState): "normal" | "refinement" | "finalization" {
  if (state.multiTurnFinalizing === true) return "finalization";
  return isActiveMultiTurnNode(state) ? "refinement" : "normal";
}

function recoveryIdentityKey(state: MateriaCastState): string {
  const nodeId = state.currentNode ?? state.phase;
  const visit = state.currentNode ? nodeVisit(state, state.currentNode) : 0;
  const refinementTurn = state.currentNode ? currentRefinementTurn(state, state.currentNode) : 0;
  return JSON.stringify([recoveryTurnMode(state), nodeId, state.currentItemKey ?? "__singleton__", visit, refinementTurn]);
}

function recoveryDiagnosticLabel(state: MateriaCastState): string {
  const item = state.currentItemKey ? ` item ${JSON.stringify(state.currentItemKey)}` : "";
  return `${recoveryTurnMode(state)} turn for node "${state.currentNode ?? state.phase}"${item}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function nonRecoverableTurnError(state: MateriaCastState, error: unknown): Error {
  return new Error(`Non-recoverable turn failure for ${recoveryDiagnosticLabel(state)} (same-node recovery not attempted): ${errorMessage(error)}`);
}

async function failCast(pi: ExtensionAPI, ctx: ExtensionContext, state: MateriaCastState, error: unknown, entryId?: string): Promise<void> {
  state.active = false;
  state.awaitingResponse = false;
  state.nodeState = "failed";
  state.phase = "failed";
  state.failedReason = error instanceof Error ? error.message : String(error);
  state.runState.lastMessage = state.failedReason;
  await appendEvent(state.runState, "cast_end", { ok: false, error: state.failedReason, entryId, node: state.currentNode });
  await writeUsage(state.runState);
  await appendManifest(state, { phase: "failed", node: state.currentNode, materia: state.currentMateria, itemKey: state.currentItemKey, entryId });
  saveCastState(pi, state);
  ctx.ui.setStatus("materia", "failed");
  updateWidget(ctx, state.runState);
  ctx.ui.notify(`pi-materia cast failed: ${state.failedReason}`, "error");
}

function enforceNodeLimit(state: MateriaCastState, node: ResolvedMateriaNode, config: PiMateriaConfig): void {
  const count = (state.visits[node.id] ?? 0) + 1;
  const limit = node.node.limits?.maxVisits ?? config.limits?.maxNodeVisits ?? DEFAULT_MAX_NODE_VISITS;
  if (count > limit) throw new Error(`Materia node visit limit exceeded for ${node.id} (${count}/${limit}).`);
  state.visits[node.id] = count;
}

function setCurrentItem(state: MateriaCastState, node: ResolvedMateriaNode): boolean {
  const loop = node.node.foreach ?? loopIteratorForNode(state.pipeline, node.id);
  if (!loop) {
    state.currentItemKey = undefined;
    state.currentItemLabel = undefined;
    return true;
  }
  const cursor = loop.cursor ?? `${node.id}Index`;
  const index = state.cursors[cursor] ?? 0;
  state.cursors[cursor] = index;
  const item = asArray(resolveValue(loop.items, state))[index];
  if (item === undefined) {
    state.currentItemKey = undefined;
    state.currentItemLabel = undefined;
    return false;
  }
  const alias = loop.as ?? "item";
  setPath(state.data, "item", item);
  setPath(state.data, alias, item);
  const key = readObjectField(item, "id") ?? readObjectField(item, "key") ?? index;
  const label = readObjectField(item, "title") ?? readObjectField(item, "name") ?? key;
  state.currentItemKey = String(key);
  state.currentItemLabel = String(label);
  return true;
}

async function finishCast(pi: ExtensionAPI, ctx: ExtensionContext, state: MateriaCastState, entryId: string, message: string): Promise<void> {
  state.active = false;
  state.phase = "complete";
  state.awaitingResponse = false;
  state.nodeState = "complete";
  state.updatedAt = Date.now();
  state.runState.lastMessage = message;
  await writeUsage(state.runState);
  await appendEvent(state.runState, "cast_end", { ok: true, usage: state.runState.usage, entryId });
  await appendManifest(state, { phase: "complete", entryId });
  saveCastState(pi, state);
  ctx.ui.setStatus("materia", "done");
  updateWidget(ctx, state.runState);
  showUsageSummary(ctx, state.runState);
  ctx.ui.notify(`pi-materia cast complete. ${formatUsage(state.runState.usage, state.runState.usage.costKind)}`, "info");
}

async function sendMateriaTurn(pi: ExtensionAPI, ctx: ExtensionContext, state: MateriaCastState, prompt: string, options: { skipProactiveCompaction?: boolean } = {}): Promise<void> {
  state.activeTurnPrompt = prompt;
  saveCastState(pi, state);
  if (!options.skipProactiveCompaction) await maybeRunProactiveCompaction(pi, ctx, state);
  const contextArtifact = await writeContextArtifact(pi, state, prompt);
  await appendManifest(state, { phase: state.phase, node: state.currentNode, materia: state.currentMateria, itemKey: state.currentItemKey, visit: state.currentNode ? nodeVisit(state, state.currentNode) : undefined, artifact: contextArtifact, kind: "context", materiaModel: state.currentMateriaModel });

  const label = state.currentItemLabel ? `${state.phase}: ${state.currentItemLabel}` : state.phase;
  pi.sendMessage({
    customType: "pi-materia",
    content: `Casting **${state.currentMateria ?? "materia"}**\n\n${label}`,
    display: true,
    details: { prefix: label, nodeId: state.currentNode, materiaName: state.currentMateria, itemKey: state.currentItemKey, itemLabel: state.currentItemLabel, eventType: "materia_prompt", materiaModel: state.currentMateriaModel },
  });

  pi.appendEntry("pi-materia-context", { phase: state.phase, nodeId: state.currentNode, materiaName: state.currentMateria, itemKey: state.currentItemKey, itemLabel: state.currentItemLabel, itemLabelShort: shortMetadataLabel(state.currentItemLabel), artifact: contextArtifact, materiaModel: state.currentMateriaModel });
  pi.sendMessage({
    customType: "pi-materia-prompt",
    content: prompt,
    display: false,
    details: { phase: state.phase, nodeId: state.currentNode, materiaName: state.currentMateria, itemKey: state.currentItemKey, itemLabel: state.currentItemLabel, materiaModel: state.currentMateriaModel },
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
  const modelSource = materiaModel?.modelExplicit ? "configured materia setting" : "active Pi model fallback";
  const content = [
    "# Materia Isolated Context",
    "",
    `cast: ${state.castId}`,
    `node: ${state.currentNode ?? "-"}`,
    `materia: ${state.currentMateria ?? "-"}`,
    `item: ${state.currentItemLabel ?? "-"}`,
    `visit: ${state.currentNode ? nodeVisit(state, state.currentNode) : "-"}`,
    `model: ${model}`,
    `model source: ${modelSource}`,
    `thinking: ${thinking}`,
    `thinking source: ${materiaModel?.thinkingExplicit ? "configured materia setting" : "active Pi thinking fallback"}`,
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
  const source = applied.modelExplicit || applied.thinkingExplicit ? "configured" : "active";
  return {
    model,
    provider,
    api: applied.api,
    thinking,
    requestedModel: applied.requestedModel,
    requestedThinking: applied.requestedThinking,
    modelExplicit: applied.modelExplicit,
    thinkingExplicit: applied.thinkingExplicit,
    source,
    label,
  };
}

function contextArtifactPath(state: MateriaCastState, suffix?: string): string {
  const node = safePathSegment(state.currentNode ?? state.phase);
  const item = state.currentItemKey ? `-${safePathSegment(state.currentItemKey)}` : "";
  const visit = state.currentNode ? nodeVisit(state, state.currentNode) : 1;
  const extra = suffix ? `-${safePathSegment(suffix)}` : "";
  return path.join("contexts", `${node}${item}-${visit}${extra}.md`);
}

function buildNodePrompt(state: MateriaCastState, node: ResolvedMateriaNode): string {
  if (!isAgentResolvedNode(node)) throw new Error(`Utility node "${node.id}" does not have an agent prompt.`);
  return materiaPrompt(node.materia, state, [multiTurnTurnInstruction(state, node), singleTurnJsonFormatInstruction(node)]);
}

function buildMultiTurnFinalizationPrompt(state: MateriaCastState, node: ResolvedMateriaNode): string {
  if (!isAgentResolvedNode(node)) throw new Error(`Utility node "${node.id}" does not have an agent prompt.`);
  return materiaPrompt(node.materia, state, [
    buildSyntheticCastContext(state),
    "Command-triggered finalization: the user ran /materia continue for this multi-turn node. This is the only finalization mechanism and this is the finalization turn.",
    finalFormatInstruction(node),
  ]);
}

function multiTurnTurnInstruction(state: MateriaCastState, node: ResolvedMateriaNode): string | undefined {
  if (!isMultiTurnResolvedAgentNode(node)) return undefined;
  return state.multiTurnFinalizing ? finalFormatInstruction(node) : multiTurnRefinementGuidance();
}

function multiTurnRefinementGuidance(): string {
  return "Current multi-turn mode: refinement conversation. /materia continue is the only way to finalize this multi-turn node. Until the user runs /materia continue, respond conversationally, incorporate refinement feedback, and do not emit final JSON, final structured output, or other final machine-parseable output. If the refinement appears complete or the conversation is stalling, prompt the user to run /materia continue when they are ready for the final output.";
}

function singleTurnJsonFormatInstruction(node: ResolvedMateriaNode): string | undefined {
  if (!isAgentResolvedNode(node)) return undefined;
  if (node.materia.multiTurn === true) return undefined;
  return node.node.parse === "json" ? finalFormatInstruction(node) : undefined;
}

function finalFormatInstruction(node: ResolvedMateriaNode): string {
  if (!isAgentResolvedNode(node)) return "";
  if (node.node.parse === "json") {
    return [
      "Final output format: Return only JSON for this node, with no markdown fences, prose, or extra commentary. Follow the schema/shape requested by the node prompt exactly.",
      HANDOFF_CONTRACT_PROMPT_TEXT,
    ].join("\n\n");
  }
  return "Final output format: return the final plain-text output for this node, with no extra refinement questions.";
}

export function activeMateriaSystemPrompt(state: MateriaCastState, materia: MateriaAgentConfig): string {
  const node = state.currentNode ? state.pipeline.nodes[state.currentNode] : undefined;
  const suffixes = node && isAgentResolvedNode(node) ? [multiTurnTurnInstruction(state, node), singleTurnJsonFormatInstruction(node)] : [];
  return [renderTemplate(materia.prompt, state), ...suffixes].filter(Boolean).join("\n\n");
}

function renderTemplate(template: string, state: MateriaCastState): string {
  return template.replace(/{{\s*([^}]+?)\s*}}/g, (_match, key: string) => stringifyTemplateValue(resolveTemplateValue(key, state)));
}

function resolveTemplateValue(key: string, state: MateriaCastState): unknown {
  const trimmed = key.trim();
  if (trimmed === "request") return state.request;
  if (trimmed === "stateJson") return JSON.stringify(state.data, null, 2);
  if (trimmed === "itemJson") return JSON.stringify(currentItem(state), null, 2);
  if (trimmed === "lastOutput") return state.lastOutput ?? "";
  if (trimmed === "lastJson") return state.lastJson ?? "";
  if (trimmed.startsWith("state.")) return getPath(state.data, trimmed.slice("state.".length));
  if (trimmed.startsWith("cursor.")) return state.cursors[trimmed.slice("cursor.".length)];
  if (trimmed.startsWith("item.")) return getPath(currentItem(state), trimmed.slice("item.".length));
  if (trimmed.startsWith("lastJson.")) return getPath(state.lastJson, trimmed.slice("lastJson.".length));
  return getPath(state.data, trimmed);
}

export async function prepareMultiTurnRefinementTurn(pi: ExtensionAPI, ctx: ExtensionContext, state: MateriaCastState): Promise<void> {
  if (!isPausedMultiTurnRefinement(state)) return;
  const node = currentNodeOrThrow(state);
  if (!isAgentResolvedNode(node)) return;

  const appliedModel = await applyMateriaModelSettings(pi, ctx, { materiaName: node.node.materia, model: node.materia.model, thinking: node.materia.thinking });
  const materiaModel = materiaModelSelection(appliedModel);
  state.currentMateria = nodeMateriaName(node);
  state.currentMateriaModel = materiaModel;
  state.runState.currentMateria = nodeMateriaName(node);
  state.runState.currentMateriaModel = materiaModel;
  state.awaitingResponse = true;
  state.nodeState = "awaiting_agent_response";
  state.multiTurnFinalizing = false;
  state.activeTurnPrompt = materiaPrompt(node.materia, state, [buildSyntheticCastContext(state), multiTurnRefinementGuidance()]);
  state.updatedAt = Date.now();
  const refinementTurn = currentRefinementTurn(state, node.id) + 1;
  recordUsageModelSelection(state.runState.usage, { node: node.id, materia: node.node.materia, taskId: state.currentItemKey, attempt: state.runState.attempt, materiaModel });
  await writeUsage(state.runState);
  await appendEvent(state.runState, "materia_model_settings", { node: node.id, materia: node.node.materia, visit: nodeVisit(state, node.id), itemKey: state.currentItemKey, itemLabel: state.currentItemLabel, itemLabelShort: shortMetadataLabel(state.currentItemLabel), materiaModel, refinementTurn });
  const contextArtifact = await writeContextArtifact(pi, state, buildSyntheticCastContext(state), `refinement-${refinementTurn}-${safeTimestamp()}`);
  await appendManifest(state, { phase: state.phase, node: state.currentNode, materia: state.currentMateria, itemKey: state.currentItemKey, visit: nodeVisit(state, node.id), artifact: contextArtifact, kind: "context_refinement", refinementTurn, materiaModel: state.currentMateriaModel });
  await appendEvent(state.runState, "context_refinement", { node: node.id, materia: nodeMateriaName(node), artifact: contextArtifact, refinementTurn, itemKey: state.currentItemKey, itemLabel: state.currentItemLabel, itemLabelShort: shortMetadataLabel(state.currentItemLabel), materiaModel });
  updateToolScope(pi, node.materia);
  saveCastState(pi, state);
}

export function buildIsolatedMateriaContext(messages: unknown[], state: MateriaCastState): unknown[] {
  if (!shouldUseIsolatedMateriaContext(state)) return messages;
  const materiaStart = findActiveMateriaPromptIndex(messages);
  if (materiaStart < 0) return messages;
  return [createUserMessage(buildSyntheticCastContext(state)), ...messages.slice(materiaStart)];
}

function shouldUseIsolatedMateriaContext(state: MateriaCastState): boolean {
  return state.active && (state.awaitingResponse || isPausedMultiTurnRefinement(state));
}

function isPausedMultiTurnRefinement(state: MateriaCastState): boolean {
  return !state.awaitingResponse && state.nodeState === "awaiting_user_refinement" && isActiveMultiTurnNode(state);
}

function isActiveMultiTurnNode(state: MateriaCastState): boolean {
  if (!state.active) return false;
  const node = state.currentNode ? state.pipeline.nodes[state.currentNode] : undefined;
  return Boolean(node && isMultiTurnResolvedAgentNode(node));
}

function buildSyntheticCastContext(state: MateriaCastState): string {
  const latestOutput = state.lastAssistantText ?? state.lastOutput;
  const activeMultiTurn = isActiveMultiTurnNode(state);
  const multiTurnRefining = activeMultiTurn && state.multiTurnFinalizing !== true;
  const mode = activeMultiTurn
    ? `multi-turn refinement (${state.multiTurnFinalizing === true ? "/materia continue finalization" : state.nodeState === "awaiting_user_refinement" ? "awaiting user refinement or /materia continue" : state.nodeState ?? "active"})`
    : state.nodeState ?? "active";
  return [
    "Materia isolated context.",
    "Use only this cast context, the current materia prompt, and any tool results from this materia turn. Do not rely on unrelated earlier visible transcript messages.",
    multiTurnRefining ? multiTurnRefinementGuidance() : undefined,
    "",
    `Cast id: ${state.castId}`,
    `Original request: ${state.request}`,
    `Current node: ${state.currentNode ?? "-"}`,
    `Current materia: ${state.currentMateria ?? "-"}`,
    `Current item: ${state.currentItemLabel ?? "-"}`,
    `Mode: ${mode}`,
    `Effective model: ${state.currentMateriaModel?.label ?? "active Pi model"}`,
    `Effective thinking: ${state.currentMateriaModel?.thinking ?? "active Pi thinking"}`,
    `Artifact directory: ${state.runDir}`,
    "",
    "Generic cast data:",
    JSON.stringify(state.data, null, 2),
    "",
    latestOutput ? `Previous output:\n${latestOutput}` : undefined,
  ].filter(Boolean).join("\n");
}

function findActiveMateriaPromptIndex(messages: unknown[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as { content?: unknown; role?: unknown };
    if (isToolOrAssistantMessage(message)) continue;
    const text = messageContentText(message.content);
    if (text.includes("<materia-instructions>") && text.includes("</materia-instructions>")) return i;
  }
  return -1;
}

function isToolOrAssistantMessage(message: { role?: unknown }): boolean {
  return message.role === "assistant" || message.role === "tool" || message.role === "toolResult";
}

function createUserMessage(content: string): unknown {
  return { role: "user", content, timestamp: Date.now() };
}

function messageContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    const value = part as { type?: unknown; text?: unknown };
    return value.type === "text" && typeof value.text === "string" ? value.text : "";
  }).join("\n");
}

function materiaPrompt(materia: MateriaAgentConfig, state: MateriaCastState, sections: (string | undefined)[]): string {
  return ["<materia-instructions>", renderTemplate(materia.prompt, state), "</materia-instructions>", ...sections.filter(Boolean)].join("\n\n");
}

function evaluateEdgeCondition(condition: string, state: MateriaCastState, parsed: unknown): boolean {
  if (condition === "always") return true;
  const satisfied = resolveValue(`$.${HANDOFF_SATISFIED_FIELD}`, state, parsed);
  if (condition === "satisfied") return satisfied === true;
  if (condition === "not_satisfied") return satisfied === false;
  throw new Error(`Unsupported Materia edge condition: ${condition}`);
}

function evaluateCondition(condition: string, state: MateriaCastState, parsed: unknown): boolean {
  const text = condition.trim();
  if (text === "always") return true;
  if (text === "satisfied") return resolveValue("$.satisfied", state, parsed) === true;
  if (text === "not_satisfied") return resolveValue("$.satisfied", state, parsed) === false;
  const exists = text.match(/^!?exists\((.+)\)$/);
  if (exists) {
    const value = resolveValue(exists[1].trim(), state, parsed);
    return text.startsWith("!") ? value === undefined : value !== undefined;
  }
  const match = text.match(/^(.+?)\s*(==|!=)\s*(.+)$/);
  if (!match) throw new Error(`Unsupported Materia condition: ${condition}`);
  const left = resolveValue(match[1].trim(), state, parsed);
  const right = parseLiteral(match[3].trim(), state, parsed);
  return match[2] === "==" ? left === right : left !== right;
}

function parseLiteral(input: string, state: MateriaCastState, parsed: unknown): unknown {
  if (input === "true") return true;
  if (input === "false") return false;
  if (input === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(input)) return Number(input);
  if ((input.startsWith('"') && input.endsWith('"')) || (input.startsWith("'") && input.endsWith("'"))) return input.slice(1, -1);
  return resolveValue(input, state, parsed);
}

function resolveValue(source: string, state: MateriaCastState, parsed: unknown = state.lastJson): unknown {
  if (source === "$") return parsed;
  if (source.startsWith("$.")) return getPath(parsed, source.slice(2));
  if (source === "state") return state.data;
  if (source.startsWith("state.")) return getPath(state.data, source.slice("state.".length));
  if (source === "item") return currentItem(state);
  if (source.startsWith("item.")) return getPath(currentItem(state), source.slice("item.".length));
  if (source === "lastJson") return state.lastJson;
  if (source.startsWith("lastJson.")) return getPath(state.lastJson, source.slice("lastJson.".length));
  if (source === "lastOutput") return state.lastOutput;
  return getPath(state.data, source);
}

function currentItem(state: MateriaCastState): unknown {
  return state.data.item;
}

function getPath(value: unknown, pathValue: string): unknown {
  if (!pathValue) return value;
  return pathValue.split(".").reduce<unknown>((current, part) => {
    if (current === undefined || current === null) return undefined;
    if (Array.isArray(current) && /^\d+$/.test(part)) return current[Number(part)];
    if (typeof current === "object") return (current as Record<string, unknown>)[part];
    return undefined;
  }, value);
}

function setPath(target: Record<string, unknown>, pathValue: string, value: unknown): void {
  const parts = pathValue.split(".").filter(Boolean);
  if (!parts.length) throw new Error("Materia assignment target cannot be empty.");
  let current: Record<string, unknown> = target;
  for (const part of parts.slice(0, -1)) {
    const next = current[part];
    if (!next || typeof next !== "object" || Array.isArray(next)) current[part] = {};
    current = current[part] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]] = value;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readObjectField(value: unknown, field: string): unknown {
  return value && typeof value === "object" ? (value as Record<string, unknown>)[field] : undefined;
}

function stringifyTemplateValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

export const nativeTestInternals = {
  evaluateCondition,
  renderTemplate,
  resolveValue,
  selectNextTarget,
  setPath,
};

function nodeVisit(state: MateriaCastState, nodeId: string): number {
  return state.visits[nodeId] ?? 0;
}

function currentRefinementTurn(state: MateriaCastState, nodeId: string): number {
  return state.multiTurnRefinements?.[refinementIdentityKey(state, nodeId)] ?? 0;
}

function nextRefinementTurn(state: MateriaCastState, nodeId: string): number {
  state.multiTurnRefinements ??= {};
  const key = refinementIdentityKey(state, nodeId);
  const turn = (state.multiTurnRefinements[key] ?? 0) + 1;
  state.multiTurnRefinements[key] = turn;
  return turn;
}

function refinementIdentityKey(state: MateriaCastState, nodeId: string): string {
  return JSON.stringify([nodeId, state.currentItemKey ?? "__singleton__", nodeVisit(state, nodeId)]);
}

function taskIdentityKey(state: MateriaCastState, nodeId: string): string {
  return JSON.stringify([nodeId, state.currentItemKey ?? "__singleton__"]);
}

function startTaskAttempt(state: MateriaCastState, nodeId: string): number {
  state.taskAttempts ??= {};
  const key = taskIdentityKey(state, nodeId);
  const attempt = (state.taskAttempts[key] ?? 0) + 1;
  state.taskAttempts[key] = attempt;
  return attempt;
}

function currentTaskAttempt(state: MateriaCastState): number | undefined {
  if (!state.currentNode) return undefined;
  return state.runState.attempt ?? state.taskAttempts?.[taskIdentityKey(state, state.currentNode)];
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
  state.nodeState = "failed";
  state.phase = reason === "aborted" ? "failed" : state.phase;
  state.failedReason = reason;
  state.updatedAt = Date.now();
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
  const node = state.currentNode ?? state.phase;
  const materia = state.currentMateria ?? state.phase;
  addUsage(state.runState.usage, usage, { node, materia, taskId: state.currentItemKey, attempt: currentTaskAttempt(state), materiaModel: state.currentMateriaModel, messageModel: extractMessageModelInfo(message) });
}

function updateToolScope(pi: ExtensionAPI, materia: MateriaAgentConfig): void {
  const all = pi.getAllTools().map((tool) => tool.name);
  const readOnly = all.filter((name) => ["read", "grep", "find", "ls"].includes(name));
  if (materia.tools === "none") pi.setActiveTools([]);
  else if (materia.tools === "readOnly") pi.setActiveTools(readOnly);
  else pi.setActiveTools(all);
}

export function currentMateria(state: MateriaCastState): MateriaAgentConfig {
  const node = currentNodeOrThrow(state);
  if (!isAgentResolvedNode(node)) throw new Error(`Current Materia node "${node.id}" is a utility node and has no materia.`);
  return node.materia;
}

function nodeMateriaName(node: ResolvedMateriaNode): string | undefined {
  return isAgentResolvedNode(node) ? node.node.materia : undefined;
}

function isAgentResolvedNode(node: ResolvedMateriaNode): node is ResolvedMateriaAgentNode {
  return node.node.type === "agent";
}

function isMultiTurnResolvedAgentNode(node: ResolvedMateriaNode): node is ResolvedMateriaAgentNode {
  return isAgentResolvedNode(node) && node.materia.multiTurn === true;
}

function currentNodeOrThrow(state: MateriaCastState): ResolvedMateriaNode {
  const node = state.currentNode ? state.pipeline.nodes[state.currentNode] : state.pipeline.entry;
  if (!node) throw new Error(`Current Materia node "${state.currentNode}" is not in the resolved grid.`);
  return node;
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
