import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@mariozechner/pi-coding-agent";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { appendEvent, safePathSegment, safeTimestamp } from "./artifacts.js";
import { resolveArtifactRoot } from "./config.js";
import { parseJson } from "./json.js";
import type { EvaluationResult, LoadedConfig, MateriaCastPhase, MateriaCastState, MateriaManifest, MateriaManifestEntry, MateriaRoleConfig, PiMateriaConfig, PlannedTask, PlanResult, ResolvedMateriaNode, ResolvedMateriaPipeline } from "./types.js";
import { updateWidget, showUsageSummary } from "./ui.js";
import { addUsage, assertBudget, createRunState, extractUsage, writeUsage } from "./usage.js";

const STATE_ENTRY = "pi-materia-cast-state";
const MANIFEST_FILE = "manifest.json";

export async function startNativeCast(pi: ExtensionAPI, ctx: ExtensionContext, loaded: LoadedConfig, pipeline: ResolvedMateriaPipeline, request: string): Promise<void> {
  const config = loaded.config;
  const artifactRoot = resolveArtifactRoot(ctx.cwd, config.artifactDir);
  const castId = safeTimestamp();
  const runDir = path.join(artifactRoot, castId);
  await mkdir(path.join(runDir, "tasks"), { recursive: true });
  await mkdir(path.join(runDir, "maintenance"), { recursive: true });
  await writeFile(path.join(runDir, "config.resolved.json"), JSON.stringify(config, null, 2));

  const runState = createRunState(castId, runDir, ctx.model);
  runState.currentNode = pipeline.planner.id;
  runState.currentRole = pipeline.planner.node.role;
  runState.lastMessage = "planning";
  await writeUsage(runState);
  await appendEvent(runState, "cast_start", { request, configSource: loaded.source, artifactRoot, pipeline: config.pipeline, nativeSession: true });
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
    phase: "planning",
    currentNode: pipeline.planner.id,
    currentRole: pipeline.planner.node.role,
    currentTaskIndex: 0,
    tasks: [],
    attempt: 0,
    awaitingResponse: true,
    startedAt: Date.now(),
    updatedAt: Date.now(),
    runState,
    pipeline,
  };

  pi.setSessionName(`materia: ${request.slice(0, 60)}`);
  saveCastState(pi, state);
  updateToolScope(pi, pipeline.planner.role);
  updateWidget(ctx, state.runState);
  ctx.ui.setStatus("materia", `planning:${pipeline.planner.id}`);
  ctx.ui.notify(`pi-materia native cast started. Artifacts: ${runDir}`, "info");
  pi.sendUserMessage(buildPlannerPrompt(request, pipeline.planner.role));
}

export async function continueNativeCast(pi: ExtensionAPI, ctx: ExtensionContext, state: MateriaCastState): Promise<void> {
  if (!state.active) throw new Error("No active pi-materia cast to continue.");
  if (state.awaitingResponse) throw new Error("Materia is already awaiting a Pi agent response.");
  const prompt = nextPromptForState(state);
  state.awaitingResponse = true;
  state.updatedAt = Date.now();
  saveCastState(pi, state);
  updateToolScope(pi, currentRole(state));
  pi.sendUserMessage(prompt);
}

export async function handleAgentEnd(pi: ExtensionAPI, event: { messages: unknown[] }, ctx: ExtensionContext): Promise<void> {
  const state = loadActiveCastState(ctx);
  if (!state?.active || !state.awaitingResponse) return;

  const latest = findLatestAssistantEntry(ctx.sessionManager.getEntries(), state.lastProcessedEntryId);
  if (!latest) return;
  if (latest.entry.id === state.lastProcessedEntryId) return;

  const text = assistantText(latest.message);
  state.lastProcessedEntryId = latest.entry.id;
  state.lastAssistantText = text;
  state.awaitingResponse = false;
  state.updatedAt = Date.now();
  captureUsage(state, latest.message);

  try {
    await transitionFromAssistant(pi, ctx, state, text, latest.entry.id);
  } catch (error) {
    state.active = false;
    state.phase = "failed";
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

async function transitionFromAssistant(pi: ExtensionAPI, ctx: ExtensionContext, state: MateriaCastState, text: string, entryId: string): Promise<void> {
  const pipeline = state.pipeline;
  const config = await loadConfigFromState(state);

  if (state.phase === "planning") {
    const plan = parseJson<PlanResult>(text);
    state.tasks = plan.tasks;
    state.currentTaskIndex = 0;
    await writeFile(path.join(state.runDir, "plan.json"), JSON.stringify(plan, null, 2));
    await appendEvent(state.runState, "plan", plan);
    await appendManifest(state, { phase: "planning", node: pipeline.planner.id, role: pipeline.planner.node.role, entryId, artifact: "plan.json" });
    pi.appendEntry("pi-materia-plan", plan);
    ctx.ui.notify(`pi-materia planned ${plan.tasks.length} task(s).`, "info");

    if (plan.tasks.length === 0) return await finishCast(pi, ctx, state, entryId, "No tasks planned.");
    await startBuild(pi, ctx, state, config);
    return;
  }

  if (state.phase === "building") {
    const task = currentTaskOrThrow(state);
    await ensureTaskDir(state, task);
    const artifact = path.join("tasks", safePathSegment(task.id), `build-${state.attempt}.md`);
    await writeFile(path.join(state.runDir, artifact), text);
    state.lastBuildSummary = text;
    await appendEvent(state.runState, "build", { taskId: task.id, attempt: state.attempt, node: pipeline.builder.id, entryId });
    await appendManifest(state, { phase: "building", node: pipeline.builder.id, role: pipeline.builder.node.role, taskId: task.id, attempt: state.attempt, entryId, artifact });
    await assertBudget(config, state.runState, ctx);
    await startEvaluation(pi, ctx, state);
    return;
  }

  if (state.phase === "evaluating") {
    const task = currentTaskOrThrow(state);
    const evaluation = parseJson<EvaluationResult>(text);
    const artifact = path.join("tasks", safePathSegment(task.id), `eval-${state.attempt}.json`);
    await writeFile(path.join(state.runDir, artifact), JSON.stringify(evaluation, null, 2));
    await appendEvent(state.runState, "evaluation", { taskId: task.id, attempt: state.attempt, node: pipeline.evaluator.id, evaluation, entryId });
    await appendManifest(state, { phase: "evaluating", node: pipeline.evaluator.id, role: pipeline.evaluator.node.role, taskId: task.id, attempt: state.attempt, entryId, artifact });
    await assertBudget(config, state.runState, ctx);

    if (evaluation.passed) {
      ctx.ui.notify(`pi-materia task ${task.id} passed.`, "info");
      state.currentTaskIndex += 1;
      state.lastFeedback = undefined;
      if (state.currentTaskIndex < state.tasks.length) return await startBuild(pi, ctx, state, config);
      return await maybeStartMaintenance(pi, ctx, state, config, entryId);
    }

    state.lastFeedback = evaluation.feedback || evaluation.missing?.join("\n") || "Evaluator found unresolved issues.";
    if (state.attempt >= config.maxBuilderAttempts) throw new Error(`Task ${task.id} did not pass after ${config.maxBuilderAttempts} attempts.`);
    ctx.ui.notify(`pi-materia task ${task.id} failed attempt ${state.attempt}; linking back to builder.`, "warning");
    await startBuild(pi, ctx, state, config);
    return;
  }

  if (state.phase === "maintaining") {
    const artifact = path.join("maintenance", "final.md");
    await writeFile(path.join(state.runDir, artifact), text);
    await appendEvent(state.runState, "maintenance", { node: pipeline.maintainer?.id, entryId });
    await appendManifest(state, { phase: "maintaining", node: pipeline.maintainer?.id, role: pipeline.maintainer?.node.role, entryId, artifact });
    await finishCast(pi, ctx, state, entryId, "Cast complete.");
  }
}

async function startBuild(pi: ExtensionAPI, ctx: ExtensionContext, state: MateriaCastState, _config: PiMateriaConfig): Promise<void> {
  const task = currentTaskOrThrow(state);
  state.phase = "building";
  state.currentNode = state.pipeline.builder.id;
  state.currentRole = state.pipeline.builder.node.role;
  state.currentTaskId = task.id;
  state.currentTaskTitle = task.title;
  state.attempt = state.lastFeedback ? state.attempt + 1 : 1;
  state.awaitingResponse = true;
  state.updatedAt = Date.now();
  state.runState.currentNode = state.currentNode;
  state.runState.currentRole = state.currentRole;
  state.runState.currentTask = `${task.id}: ${task.title}`;
  state.runState.attempt = state.attempt;
  state.runState.lastMessage = "building";
  await appendEvent(state.runState, "task_start", { task, attempt: state.attempt });
  await writeUsage(state.runState);
  saveCastState(pi, state);
  updateToolScope(pi, state.pipeline.builder.role);
  updateWidget(ctx, state.runState);
  ctx.ui.setStatus("materia", `${state.pipeline.builder.id}:${task.id}`);
  pi.sendUserMessage(buildBuilderPrompt(task, state.attempt, state.lastFeedback, state.pipeline.builder.role));
}

async function startEvaluation(pi: ExtensionAPI, ctx: ExtensionContext, state: MateriaCastState): Promise<void> {
  const task = currentTaskOrThrow(state);
  state.phase = "evaluating";
  state.currentNode = state.pipeline.evaluator.id;
  state.currentRole = state.pipeline.evaluator.node.role;
  state.awaitingResponse = true;
  state.updatedAt = Date.now();
  state.runState.currentNode = state.currentNode;
  state.runState.currentRole = state.currentRole;
  state.runState.currentTask = `${task.id}: ${task.title}`;
  state.runState.attempt = state.attempt;
  state.runState.lastMessage = "evaluating";
  await writeUsage(state.runState);
  saveCastState(pi, state);
  updateToolScope(pi, state.pipeline.evaluator.role);
  updateWidget(ctx, state.runState);
  ctx.ui.setStatus("materia", `${state.pipeline.evaluator.id}:${task.id}`);
  pi.sendUserMessage(buildEvaluatorPrompt(task, state.lastBuildSummary ?? "", state.pipeline.evaluator.role));
}

async function maybeStartMaintenance(pi: ExtensionAPI, ctx: ExtensionContext, state: MateriaCastState, config: PiMateriaConfig, entryId: string): Promise<void> {
  if (!state.pipeline.maintainer) return await finishCast(pi, ctx, state, entryId, "All tasks passed.");
  const shouldMaintain = config.autoCommit || (ctx.hasUI && await ctx.ui.confirm("pi-materia", "All tasks passed. Let maintainer checkpoint the work?"));
  if (!shouldMaintain) return await finishCast(pi, ctx, state, entryId, "All tasks passed; maintainer skipped.");
  state.phase = "maintaining";
  state.currentNode = state.pipeline.maintainer.id;
  state.currentRole = state.pipeline.maintainer.node.role;
  state.currentTaskId = undefined;
  state.currentTaskTitle = undefined;
  state.attempt = 0;
  state.awaitingResponse = true;
  state.updatedAt = Date.now();
  state.runState.currentNode = state.currentNode;
  state.runState.currentRole = state.currentRole;
  state.runState.currentTask = undefined;
  state.runState.attempt = undefined;
  state.runState.lastMessage = "maintaining";
  await writeUsage(state.runState);
  saveCastState(pi, state);
  updateToolScope(pi, state.pipeline.maintainer.role);
  updateWidget(ctx, state.runState);
  ctx.ui.setStatus("materia", `maintaining:${state.pipeline.maintainer.id}`);
  pi.sendUserMessage(buildMaintainerPrompt(state.pipeline.maintainer.role));
}

async function finishCast(pi: ExtensionAPI, ctx: ExtensionContext, state: MateriaCastState, entryId: string, message: string): Promise<void> {
  state.active = false;
  state.phase = "complete";
  state.awaitingResponse = false;
  state.updatedAt = Date.now();
  state.runState.lastMessage = message;
  await writeUsage(state.runState);
  await appendEvent(state.runState, "cast_end", { ok: true, usage: state.runState.usage, entryId });
  await appendManifest(state, { phase: "complete", entryId });
  saveCastState(pi, state);
  ctx.ui.setStatus("materia", "done");
  updateWidget(ctx, state.runState);
  showUsageSummary(ctx, state.runState);
  ctx.ui.notify(`pi-materia cast complete. Tokens: ${state.runState.usage.tokens.total}, cost: $${state.runState.usage.cost.total.toFixed(4)}`, "info");
}

function nextPromptForState(state: MateriaCastState): string {
  if (state.phase === "planning") return buildPlannerPrompt(state.request, state.pipeline.planner.role);
  if (state.phase === "building") return buildBuilderPrompt(currentTaskOrThrow(state), state.attempt || 1, state.lastFeedback, state.pipeline.builder.role);
  if (state.phase === "evaluating") return buildEvaluatorPrompt(currentTaskOrThrow(state), state.lastBuildSummary ?? "", state.pipeline.evaluator.role);
  if (state.phase === "maintaining" && state.pipeline.maintainer) return buildMaintainerPrompt(state.pipeline.maintainer.role);
  throw new Error(`Cannot continue cast in phase ${state.phase}`);
}

export function buildPlannerPrompt(request: string, role: MateriaRoleConfig): string {
  return rolePrompt(role, [
    "You are the Planner Materia in a Pi-native Materia cast.",
    "Create an implementation plan for this request.",
    'Return only JSON with shape: { "tasks": [{ "id": string, "title": string, "description": string, "acceptance": string[] }] }.',
    `Request: ${request}`,
  ]);
}

export function buildBuilderPrompt(task: PlannedTask, attempt: number, feedback: string | undefined, role: MateriaRoleConfig): string {
  return rolePrompt(role, [
    "You are the Builder Materia in a Pi-native Materia cast.",
    `Task ${task.id}: ${task.title}`,
    task.description,
    `Acceptance criteria:\n${task.acceptance.map((a) => `- ${a}`).join("\n")}`,
    attempt > 1 && feedback ? `Previous evaluator feedback:\n${feedback}` : "",
    "Implement the task now using normal Pi tools. Run relevant checks and summarize what changed.",
  ]);
}

export function buildEvaluatorPrompt(task: PlannedTask, buildSummary: string, role: MateriaRoleConfig): string {
  return rolePrompt(role, [
    "You are the Evaluator Materia in a Pi-native Materia cast.",
    "Evaluate whether the task is complete. Inspect the repository as needed.",
    'Return only JSON with shape: { "passed": boolean, "feedback": string, "missing": string[] }.',
    `Task: ${JSON.stringify(task, null, 2)}`,
    `Builder summary: ${buildSummary}`,
  ]);
}

export function buildMaintainerPrompt(role: MateriaRoleConfig): string {
  return rolePrompt(role, [
    "You are the Maintainer Materia in a Pi-native Materia cast.",
    "All planned tasks passed evaluation.",
    "Inspect the repository state and create an appropriate checkpoint/commit only if you are satisfied with the final state.",
    "Follow your maintainer role instructions for the correct VCS commands.",
  ]);
}

function rolePrompt(role: MateriaRoleConfig, sections: (string | undefined)[]): string {
  return [
    "<materia-role-instructions>",
    role.systemPrompt,
    "</materia-role-instructions>",
    ...sections.filter(Boolean),
  ].join("\n\n");
}

export function loadActiveCastState(ctx: ExtensionContext): MateriaCastState | undefined {
  const entries = ctx.sessionManager.getBranch();
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type === "custom" && entry.customType === STATE_ENTRY && entry.data) {
      return entry.data as MateriaCastState;
    }
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

function captureUsage(state: MateriaCastState, message: unknown): void {
  const usage = extractUsage(message);
  if (!usage) return;
  const node = state.currentNode ?? state.phase;
  const role = state.currentRole ?? state.phase;
  addUsage(state.runState.usage, usage, { node, role, taskId: state.currentTaskId, attempt: state.attempt || undefined });
}

function updateToolScope(pi: ExtensionAPI, role: MateriaRoleConfig): void {
  const all = pi.getAllTools().map((tool) => tool.name);
  const readOnly = all.filter((name) => ["read", "grep", "find", "ls"].includes(name));
  if (role.tools === "none") pi.setActiveTools([]);
  else if (role.tools === "readOnly") pi.setActiveTools(readOnly);
  else pi.setActiveTools(all);
}

function currentRole(state: MateriaCastState): MateriaRoleConfig {
  if (state.phase === "planning") return state.pipeline.planner.role;
  if (state.phase === "building") return state.pipeline.builder.role;
  if (state.phase === "evaluating") return state.pipeline.evaluator.role;
  if (state.phase === "maintaining" && state.pipeline.maintainer) return state.pipeline.maintainer.role;
  return state.pipeline.planner.role;
}

function currentTaskOrThrow(state: MateriaCastState): PlannedTask {
  const task = state.tasks[state.currentTaskIndex];
  if (!task) throw new Error("Materia cast has no current task.");
  return task;
}

async function ensureTaskDir(state: MateriaCastState, task: PlannedTask): Promise<string> {
  const taskDir = path.join(state.runDir, "tasks", safePathSegment(task.id));
  await mkdir(taskDir, { recursive: true });
  return taskDir;
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
  manifest.entries.push({ ...entry, timestamp: Date.now() });
  await writeManifest(state.runDir, manifest);
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
