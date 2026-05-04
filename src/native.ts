import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@mariozechner/pi-coding-agent";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { appendEvent, safePathSegment, safeTimestamp } from "./artifacts.js";
import { resolveArtifactRoot } from "./config.js";
import { getEffectivePipelineConfig } from "./pipeline.js";
import { parseJson } from "./json.js";
import { applyRoleModelSettings } from "./modelSettings.js";
import type { AppliedRoleModelSettings } from "./modelSettings.js";
import type { LoadedConfig, MateriaCastState, MateriaEdgeConfig, MateriaManifest, MateriaManifestEntry, MateriaRoleConfig, PiMateriaConfig, ResolvedMateriaNode, ResolvedMateriaPipeline, RoleModelSelection } from "./types.js";
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
  runState.currentRole = nodeRoleName(pipeline.entry);
  runState.lastMessage = pipeline.entry.id;
  await writeUsage(runState);
  const effectivePipeline = getEffectivePipelineConfig(config);
  await appendEvent(runState, "cast_start", { request, configSource: loaded.source, artifactRoot, pipeline: effectivePipeline.pipeline, loadout: effectivePipeline.loadoutName, nativeSession: true, isolatedRoleContext: true });
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
    currentRole: nodeRoleName(pipeline.entry),
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
      throw new Error("Materia is awaiting user refinement, but the current node's resolved role is not multi-turn.");
    }
    await finalizePausedMultiTurnNode(pi, ctx, state);
    return;
  }

  await startNode(pi, ctx, state, currentNodeOrThrow(state));
}

export async function handleMultiTurnUserInput(pi: ExtensionAPI, ctx: ExtensionContext, state: MateriaCastState, text: string): Promise<"finalized" | "continue"> {
  if (!isPausedMultiTurnRefinement(state)) return "continue";
  if (!isReadinessToContinueInstruction(text)) return "continue";
  await finalizePausedMultiTurnNode(pi, ctx, state);
  return "finalized";
}

async function finalizePausedMultiTurnNode(pi: ExtensionAPI, ctx: ExtensionContext, state: MateriaCastState): Promise<void> {
  const node = currentNodeOrThrow(state);
  if (!isMultiTurnResolvedAgentNode(node)) {
    throw new Error(`Cannot finalize refinement for node "${node.id}" because its resolved role is not multi-turn.`);
  }
  const text = state.lastAssistantText;
  if (!text) throw new Error("Multi-turn node has no assistant output to finalize.");
  const entryId = state.lastProcessedEntryId ?? `multiturn:${state.currentNode ?? state.phase}:latest`;
  state.nodeState = "idle";
  saveCastState(pi, state);
  try {
    await completeNode(pi, ctx, state, text, entryId);
  } catch (error) {
    await failCast(pi, ctx, state, error, entryId);
  }
}

export async function handleAgentEnd(pi: ExtensionAPI, event: { messages: unknown[] }, ctx: ExtensionContext): Promise<void> {
  const state = loadActiveCastState(ctx);
  if (!state?.active) return;
  const nodeAtEnd = currentNodeOrThrow(state);
  const acceptingRefinement = !state.awaitingResponse && state.nodeState === "awaiting_user_refinement" && isMultiTurnResolvedAgentNode(nodeAtEnd);
  if (!state.awaitingResponse && !acceptingRefinement) return;

  const latest = findLatestAssistantEntry(ctx.sessionManager.getEntries(), state.lastProcessedEntryId);
  if (!latest || latest.entry.id === state.lastProcessedEntryId) return;

  const text = assistantText(latest.message);
  const agentError = assistantErrorMessage(latest.message);
  state.lastProcessedEntryId = latest.entry.id;
  state.lastAssistantText = text;
  state.awaitingResponse = false;
  state.nodeState = "idle";
  state.updatedAt = Date.now();
  captureUsage(state, latest.message);

  try {
    if (agentError) throw new Error(`Pi agent turn failed for node "${state.currentNode ?? state.phase}": ${agentError}`);
    const node = currentNodeOrThrow(state);
    // Multi-turn pausing is role-driven: if the resolved agent role omits
    // multiTurn, even an interactive planning node completes and advances.
    // Keep this generic runtime gate role-name agnostic.
    if (isMultiTurnResolvedAgentNode(node)) {
      const refinement = await recordMultiTurnRefinement(state, node, text, latest.entry.id);
      state.nodeState = "awaiting_user_refinement";
      state.runState.lastMessage = `Multi-turn node ${node.id} waiting for refinement, or readiness to continue/finalize.`;
      await writeUsage(state.runState);
      await appendEvent(state.runState, "node_refinement", { node: node.id, role: nodeRoleName(node), type: node.node.type, artifact: refinement.artifact, entryId: latest.entry.id, refinementTurn: refinement.turn, itemKey: state.currentItemKey, itemLabel: state.currentItemLabel, itemLabelShort: shortMetadataLabel(state.currentItemLabel), roleModel: state.currentRoleModel });
      saveCastState(pi, state);
      ctx.ui.setStatus("materia", `${node.id}:refine`);
      updateWidget(ctx, state.runState);
      ctx.ui.notify(`pi-materia multi-turn node "${node.id}" is waiting for refinement, or readiness to continue/finalize.`, "info");
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

async function completeNode(pi: ExtensionAPI, ctx: ExtensionContext, state: MateriaCastState, text: string, entryId: string): Promise<void> {
  const config = await loadConfigFromState(state);
  const node = currentNodeOrThrow(state);
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
    state.lastJson = parsed;
    await writeFile(path.join(state.runDir, "nodes", safePathSegment(node.id), `${nodeVisit(state, node.id)}.json`), JSON.stringify(parsed, null, 2));
  }

  applyAssignments(state, node, parsed);
  const advanceTarget = applyAdvance(state, node, parsed);
  const finalizedRefinement = isMultiTurnResolvedAgentNode(node);
  await appendEvent(state.runState, "node_complete", { node: node.id, role: nodeRoleName(node), type: node.node.type, artifact, parsed: node.node.parse === "json", entryId, finalizedRefinement: finalizedRefinement || undefined, refinementTurn: finalizedRefinement ? currentRefinementTurn(state, node.id) : undefined, itemKey: state.currentItemKey, itemLabel: state.currentItemLabel, itemLabelShort: shortMetadataLabel(state.currentItemLabel), roleModel: state.currentRoleModel });
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
  await appendManifest(state, { phase: state.phase, node: node.id, role: nodeRoleName(node), itemKey: state.currentItemKey, visit, entryId, artifact, kind: "node_output", finalized: finalizedRefinement || undefined, refinementTurn: finalizedRefinement ? currentRefinementTurn(state, node.id) : undefined, roleModel: state.currentRoleModel });
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
  await appendManifest(state, { phase: state.phase, node: node.id, role: nodeRoleName(node), itemKey: state.currentItemKey, visit, entryId, artifact, kind: "node_refinement", refinementTurn: turn, roleModel: state.currentRoleModel });
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
  for (const edge of node.node.edges ?? []) {
    if (!edge.when || evaluateCondition(edge.when, state, parsed)) {
      enforceEdgeLimit(state, node.id, edge, config);
      return edge.to;
    }
  }
  return node.node.next ?? "end";
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
  if (node.node.foreach && !hasItem) return await advanceToNode(pi, ctx, state, node.node.foreach.done ?? "end", "foreach-empty");
  enforceNodeLimit(state, node, config);
  const attempt = startTaskAttempt(state, node.id);

  state.phase = node.id;
  state.currentNode = node.id;
  state.currentRole = nodeRoleName(node);
  state.currentRoleModel = undefined;
  state.awaitingResponse = true;
  state.nodeState = isAgentResolvedNode(node) ? "awaiting_agent_response" : "running_utility";
  state.updatedAt = Date.now();
  state.runState.currentNode = node.id;
  state.runState.currentRole = nodeRoleName(node);
  state.runState.currentRoleModel = undefined;
  state.runState.currentTask = state.currentItemLabel;
  state.runState.attempt = attempt;
  state.runState.lastMessage = node.id;
  await writeUsage(state.runState);
  await appendEvent(state.runState, "node_start", { node: node.id, role: nodeRoleName(node), type: node.node.type, itemKey: state.currentItemKey, itemLabel: state.currentItemLabel, itemLabelShort: shortMetadataLabel(state.currentItemLabel), visit: nodeVisit(state, node.id) });
  saveCastState(pi, state);
  updateWidget(ctx, state.runState);
  ctx.ui.setStatus("materia", state.currentItemLabel ? `${node.id}:${state.currentItemLabel}` : node.id);

  if (!isAgentResolvedNode(node)) {
    state.awaitingResponse = false;
    state.nodeState = "running_utility";
    state.currentRole = undefined;
    state.currentRoleModel = undefined;
    state.runState.currentRole = undefined;
    state.runState.currentRoleModel = undefined;
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
  const appliedModel = await applyRoleModelSettings(pi, ctx, { roleName: node.node.role, model: node.role.model, thinking: node.role.thinking });
  const roleModel = roleModelSelection(appliedModel);
  state.currentRoleModel = roleModel;
  state.runState.currentRoleModel = roleModel;
  recordUsageModelSelection(state.runState.usage, { node: node.id, role: node.node.role, taskId: state.currentItemKey, attempt: state.runState.attempt, roleModel });
  await writeUsage(state.runState);
  await appendEvent(state.runState, "role_model_settings", { node: node.id, role: node.node.role, visit: nodeVisit(state, node.id), itemKey: state.currentItemKey, itemLabel: state.currentItemLabel, itemLabelShort: shortMetadataLabel(state.currentItemLabel), roleModel });
  saveCastState(pi, state);
  updateToolScope(pi, node.role);
  await sendMateriaTurn(pi, state, buildNodePrompt(state, node));
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
  await appendManifest(state, { phase: state.phase, node: node.id, role: nodeRoleName(node), itemKey: state.currentItemKey, visit, entryId: `utility:${node.id}:${visit}:command:stdout`, artifact: stdoutArtifact });
  await appendManifest(state, { phase: state.phase, node: node.id, role: nodeRoleName(node), itemKey: state.currentItemKey, visit, entryId: `utility:${node.id}:${visit}:command:stderr`, artifact: stderrArtifact });
  await appendManifest(state, { phase: state.phase, node: node.id, role: nodeRoleName(node), itemKey: state.currentItemKey, visit, entryId: `utility:${node.id}:${visit}:command:meta`, artifact: metaArtifact });
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
  const loop = node.node.foreach;
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
  await appendManifest(state, { phase: state.phase, node: node.id, role: nodeRoleName(node), itemKey: state.currentItemKey, visit, entryId: `utility:${node.id}:${visit}:input`, artifact });
  return artifact;
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
  await appendManifest(state, { phase: "failed", node: state.currentNode, role: state.currentRole, itemKey: state.currentItemKey, entryId });
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
  const loop = node.node.foreach;
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

async function sendMateriaTurn(pi: ExtensionAPI, state: MateriaCastState, prompt: string): Promise<void> {
  const contextArtifact = await writeContextArtifact(pi, state, prompt);
  await appendManifest(state, { phase: state.phase, node: state.currentNode, role: state.currentRole, itemKey: state.currentItemKey, visit: state.currentNode ? nodeVisit(state, state.currentNode) : undefined, artifact: contextArtifact, kind: "context", roleModel: state.currentRoleModel });

  const label = state.currentItemLabel ? `${state.phase}: ${state.currentItemLabel}` : state.phase;
  pi.sendMessage({
    customType: "pi-materia",
    content: `Casting **${state.currentRole ?? "materia"}**\n\n${label}`,
    display: true,
    details: { prefix: label, nodeId: state.currentNode, roleName: state.currentRole, itemKey: state.currentItemKey, itemLabel: state.currentItemLabel, eventType: "role_prompt", roleModel: state.currentRoleModel },
  });

  pi.appendEntry("pi-materia-context", { phase: state.phase, nodeId: state.currentNode, roleName: state.currentRole, itemKey: state.currentItemKey, itemLabel: state.currentItemLabel, itemLabelShort: shortMetadataLabel(state.currentItemLabel), artifact: contextArtifact, roleModel: state.currentRoleModel });
  pi.sendMessage({
    customType: "pi-materia-prompt",
    content: prompt,
    display: false,
    details: { phase: state.phase, nodeId: state.currentNode, roleName: state.currentRole, itemKey: state.currentItemKey, itemLabel: state.currentItemLabel, roleModel: state.currentRoleModel },
  }, { triggerTurn: true });
}

async function writeContextArtifact(pi: ExtensionAPI, state: MateriaCastState, prompt: string, suffix?: string): Promise<string> {
  const relativePath = contextArtifactPath(state, suffix);
  const fullPath = path.join(state.runDir, relativePath);
  await mkdir(path.dirname(fullPath), { recursive: true });
  const activeTools = pi.getActiveTools();
  const roleModel = state.currentRoleModel;
  const model = roleModel?.label ?? "active Pi model";
  const thinking = roleModel?.thinking ?? (roleModel?.thinkingExplicit ? roleModel.requestedThinking : undefined) ?? "active Pi thinking";
  const modelSource = roleModel?.modelExplicit ? "configured role setting" : "active Pi model fallback";
  const content = [
    "# Materia Isolated Role Context",
    "",
    `cast: ${state.castId}`,
    `node: ${state.currentNode ?? "-"}`,
    `role: ${state.currentRole ?? "-"}`,
    `item: ${state.currentItemLabel ?? "-"}`,
    `visit: ${state.currentNode ? nodeVisit(state, state.currentNode) : "-"}`,
    `model: ${model}`,
    `model source: ${modelSource}`,
    `thinking: ${thinking}`,
    `thinking source: ${roleModel?.thinkingExplicit ? "configured role setting" : "active Pi thinking fallback"}`,
    `active tools: ${activeTools.length ? activeTools.join(", ") : "none"}`,
    `timestamp: ${new Date().toISOString()}`,
    "",
    "## Synthetic cast context",
    "",
    buildSyntheticCastContext(state),
    "",
    "## Hidden role prompt",
    "",
    prompt,
  ].join("\n");
  await writeFile(fullPath, content);
  return relativePath;
}

function roleModelSelection(applied: AppliedRoleModelSettings): RoleModelSelection {
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
  return rolePrompt(node.role, [renderTemplate(node.node.prompt ?? defaultNodePrompt(node), state)]);
}

function defaultNodePrompt(node: ResolvedMateriaNode): string {
  return `You are Materia slot "${node.id}" in a Pi-native Materia cast.\n\nRequest: {{request}}\n\nState:\n{{stateJson}}\n\nCurrent item:\n{{itemJson}}\n\nPrevious output:\n{{lastOutput}}\n\nPerform this slot's configured role. Be concise and make your output useful to the next linked Materia slot.`;
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

  const appliedModel = await applyRoleModelSettings(pi, ctx, { roleName: node.node.role, model: node.role.model, thinking: node.role.thinking });
  const roleModel = roleModelSelection(appliedModel);
  state.currentRole = nodeRoleName(node);
  state.currentRoleModel = roleModel;
  state.runState.currentRole = nodeRoleName(node);
  state.runState.currentRoleModel = roleModel;
  state.awaitingResponse = true;
  state.nodeState = "awaiting_agent_response";
  state.updatedAt = Date.now();
  const refinementTurn = currentRefinementTurn(state, node.id) + 1;
  recordUsageModelSelection(state.runState.usage, { node: node.id, role: node.node.role, taskId: state.currentItemKey, attempt: state.runState.attempt, roleModel });
  await writeUsage(state.runState);
  await appendEvent(state.runState, "role_model_settings", { node: node.id, role: node.node.role, visit: nodeVisit(state, node.id), itemKey: state.currentItemKey, itemLabel: state.currentItemLabel, itemLabelShort: shortMetadataLabel(state.currentItemLabel), roleModel, refinementTurn });
  const contextArtifact = await writeContextArtifact(pi, state, buildSyntheticCastContext(state), `refinement-${refinementTurn}-${safeTimestamp()}`);
  await appendManifest(state, { phase: state.phase, node: state.currentNode, role: state.currentRole, itemKey: state.currentItemKey, visit: nodeVisit(state, node.id), artifact: contextArtifact, kind: "context_refinement", refinementTurn, roleModel: state.currentRoleModel });
  await appendEvent(state.runState, "context_refinement", { node: node.id, role: nodeRoleName(node), artifact: contextArtifact, refinementTurn, itemKey: state.currentItemKey, itemLabel: state.currentItemLabel, itemLabelShort: shortMetadataLabel(state.currentItemLabel), roleModel });
  updateToolScope(pi, node.role);
  saveCastState(pi, state);
}

export function buildIsolatedMateriaContext(messages: unknown[], state: MateriaCastState): unknown[] {
  if (!shouldUseIsolatedRoleContext(state)) return messages;
  const roleStart = findActiveMateriaPromptIndex(messages);
  if (roleStart < 0) return messages;
  return [createUserMessage(buildSyntheticCastContext(state)), ...messages.slice(roleStart)];
}

function shouldUseIsolatedRoleContext(state: MateriaCastState): boolean {
  return state.active && (state.awaitingResponse || isPausedMultiTurnRefinement(state));
}

function isPausedMultiTurnRefinement(state: MateriaCastState): boolean {
  return !state.awaitingResponse && state.nodeState === "awaiting_user_refinement" && isActiveMultiTurnNode(state);
}

export function isReadinessToContinueInstruction(input: string): boolean {
  const normalized = input
    .trim()
    .toLowerCase()
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/^[\s.!?,;:()[\]{}"']+|[\s.!?,;:()[\]{}"']+$/g, "")
    .replace(/\s+/g, " ");
  if (!normalized) return false;

  const conciseReadiness = /^(?:please\s+)?(?:(?:ready|continue|finali[sz]e|proceed|ship it|looks good|lgtm)|(?:we(?:'re| are)|i(?:'m| am)) ready)(?:\s+(?:please|now|to continue|and continue|to finali[sz]e|and finali[sz]e|it|this))?$/;
  if (conciseReadiness.test(normalized)) return true;

  const readinessPhrase = /\b(?:ready to continue|ready to finali[sz]e|(?:we(?:'re| are)|i(?:'m| am)) ready|looks good|lgtm)\b/;
  const finalAction = /\b(?:continue|proceed|finali[sz]e|ship it)\b/;
  const changeRequest = /\b(?:add|change|update|revise|refine|fix|include|remove|rewrite|adjust|edit|after|but|first|before|make it)\b/;
  return (readinessPhrase.test(normalized) || finalAction.test(normalized)) && !changeRequest.test(normalized);
}

function isActiveMultiTurnNode(state: MateriaCastState): boolean {
  if (!state.active) return false;
  const node = state.currentNode ? state.pipeline.nodes[state.currentNode] : undefined;
  return Boolean(node && isMultiTurnResolvedAgentNode(node));
}

function buildSyntheticCastContext(state: MateriaCastState): string {
  const latestOutput = state.lastAssistantText ?? state.lastOutput;
  const mode = isActiveMultiTurnNode(state)
    ? `multi-turn refinement (${state.nodeState === "awaiting_user_refinement" ? "awaiting user refinement or readiness to continue/finalize" : state.nodeState ?? "active"})`
    : state.nodeState ?? "active";
  return [
    "Materia isolated context.",
    "Use only this cast context, the current role prompt, and any tool results from this role turn. Do not rely on unrelated earlier visible transcript messages.",
    "",
    `Cast id: ${state.castId}`,
    `Original request: ${state.request}`,
    `Current node: ${state.currentNode ?? "-"}`,
    `Current role: ${state.currentRole ?? "-"}`,
    `Current item: ${state.currentItemLabel ?? "-"}`,
    `Mode: ${mode}`,
    `Effective model: ${state.currentRoleModel?.label ?? "active Pi model"}`,
    `Effective thinking: ${state.currentRoleModel?.thinking ?? "active Pi thinking"}`,
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
    if (text.includes("<materia-role-instructions>") && text.includes("</materia-role-instructions>")) return i;
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

function rolePrompt(role: MateriaRoleConfig, sections: (string | undefined)[]): string {
  return ["<materia-role-instructions>", role.systemPrompt, "</materia-role-instructions>", ...sections.filter(Boolean)].join("\n\n");
}

function evaluateCondition(condition: string, state: MateriaCastState, parsed: unknown): boolean {
  const text = condition.trim();
  const exists = text.match(/^!?exists\((.+)\)$/);
  if (exists) {
    const value = resolveValue(exists[1].trim(), state, parsed);
    return text.startsWith("!") ? value === undefined : value !== undefined;
  }
  const match = text.match(/^(.+?)\s*(==|!=)\s*(.+)$/);
  if (!match) throw new Error(`Unsupported Materia edge condition: ${condition}`);
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
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type === "custom" && entry.customType === STATE_ENTRY && entry.data) return entry.data as MateriaCastState;
  }
  return undefined;
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

function captureUsage(state: MateriaCastState, message: unknown): void {
  const usage = extractUsage(message);
  if (!usage) return;
  const node = state.currentNode ?? state.phase;
  const role = state.currentRole ?? state.phase;
  addUsage(state.runState.usage, usage, { node, role, taskId: state.currentItemKey, attempt: currentTaskAttempt(state), roleModel: state.currentRoleModel, messageModel: extractMessageModelInfo(message) });
}

function updateToolScope(pi: ExtensionAPI, role: MateriaRoleConfig): void {
  const all = pi.getAllTools().map((tool) => tool.name);
  const readOnly = all.filter((name) => ["read", "grep", "find", "ls"].includes(name));
  if (role.tools === "none") pi.setActiveTools([]);
  else if (role.tools === "readOnly") pi.setActiveTools(readOnly);
  else pi.setActiveTools(all);
}

export function currentRole(state: MateriaCastState): MateriaRoleConfig {
  const node = currentNodeOrThrow(state);
  if (!isAgentResolvedNode(node)) throw new Error(`Current Materia node "${node.id}" is a utility node and has no role.`);
  return node.role;
}

function nodeRoleName(node: ResolvedMateriaNode): string | undefined {
  return isAgentResolvedNode(node) ? node.node.role : undefined;
}

function isAgentResolvedNode(node: ResolvedMateriaNode): node is Extract<ResolvedMateriaNode, { role: MateriaRoleConfig }> {
  return node.node.type === "agent";
}

function isMultiTurnResolvedAgentNode(node: ResolvedMateriaNode): node is Extract<ResolvedMateriaNode, { role: MateriaRoleConfig }> {
  return isAgentResolvedNode(node) && node.role.multiTurn === true;
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
