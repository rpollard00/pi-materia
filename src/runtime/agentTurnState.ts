import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { MateriaAgentConfig, MateriaCastState } from "../types.js";
import { resolveToolScope, type ResolvedToolScope } from "../domain/toolScope.js";
import { addUsage, extractMessageModelInfo, extractUsage } from "../telemetry/usage.js";
import { currentSocketId, currentSocketVisit, currentTaskAttempt } from "./sessionState.js";

export function findLatestAssistantEntry(entries: SessionEntry[], afterId?: string): { entry: SessionEntry; message: unknown } | undefined {
  const afterIndex = afterId ? entries.findIndex((e) => e.id === afterId) : -1;
  for (let i = entries.length - 1; i > afterIndex; i--) {
    const entry = entries[i];
    if (entry.type === "message" && (entry.message as any).role === "assistant") return { entry, message: entry.message };
  }
  return undefined;
}

export interface StaleCompletionReason {
  reason: "active_turn_socket_mismatch" | "active_turn_boundary_duplicate";
  activeTurnSocketId: string;
  activeTurnVisit: number;
  activeTurnMateria?: string;
  activeTurnBoundaryEntryId?: string;
  currentSocketId?: string;
  latestEntryId: string;
}

/**
 * Classify whether the latest assistant entry is a duplicate or stale
 * completion that does not belong to the turn currently awaiting an agent
 * response. Returns undefined when the entry belongs to the active turn, or
 * when no active-turn provenance is recorded (backward-compatible pass-through
 * for revived casts that predate this metadata).
 */
export function describeStaleCompletion(state: MateriaCastState, latestEntryId: string): StaleCompletionReason | undefined {
  const activeTurn = state.activeTurn;
  if (!activeTurn) return undefined;
  const current = currentSocketId(state);
  if (activeTurn.socketId !== current) {
    return {
      reason: "active_turn_socket_mismatch",
      activeTurnSocketId: activeTurn.socketId,
      activeTurnVisit: activeTurn.visit,
      ...(activeTurn.materia !== undefined ? { activeTurnMateria: activeTurn.materia } : {}),
      ...(activeTurn.boundaryEntryId !== undefined ? { activeTurnBoundaryEntryId: activeTurn.boundaryEntryId } : {}),
      ...(current !== undefined ? { currentSocketId: current } : {}),
      latestEntryId,
    };
  }
  // Defensive boundary guard: the boundary entry itself was already processed
  // as the prior turn's completion, so a latest entry pinned to it is stale.
  if (activeTurn.boundaryEntryId !== undefined && latestEntryId === activeTurn.boundaryEntryId) {
    return {
      reason: "active_turn_boundary_duplicate",
      activeTurnSocketId: activeTurn.socketId,
      activeTurnVisit: activeTurn.visit,
      ...(activeTurn.materia !== undefined ? { activeTurnMateria: activeTurn.materia } : {}),
      activeTurnBoundaryEntryId: activeTurn.boundaryEntryId,
      ...(current !== undefined ? { currentSocketId: current } : {}),
      latestEntryId,
    };
  }
  return undefined;
}

/**
 * Record active-turn provenance on cast state at prompt-dispatch time so
 * handleAgentEnd can reject duplicate or stale completions for other turns.
 * Captures the current socket id, visit, materia, and the session entry
 * boundary (lastProcessedEntryId) after which an assistant response is valid.
 */
export function recordActiveTurnProvenance(state: MateriaCastState): void {
  const socketId = currentSocketId(state);
  if (socketId === undefined) {
    state.activeTurn = undefined;
    return;
  }
  state.activeTurn = {
    socketId,
    visit: currentSocketVisit(state, 0),
    ...(state.currentMateria !== undefined ? { materia: state.currentMateria } : {}),
    ...(state.lastProcessedEntryId !== undefined ? { boundaryEntryId: state.lastProcessedEntryId } : {}),
  };
}

export function assistantText(message: unknown): string {
  const content = (message as any)?.content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => part?.type === "text" ? part.text : "").filter(Boolean).join("\n").trim();
}

export function assistantErrorMessage(message: unknown): string | undefined {
  const value = message as { stopReason?: unknown; errorMessage?: unknown };
  if (value.stopReason !== "error") return undefined;
  return typeof value.errorMessage === "string" && value.errorMessage.trim() ? value.errorMessage : "unknown agent error";
}

export function agentEndFailureMessage(event: unknown): string | undefined {
  const value = event as { error?: unknown; errorMessage?: unknown; message?: unknown; reason?: unknown; stopReason?: unknown };
  const candidates = [value.errorMessage, value.error, value.message, value.reason].filter((candidate): candidate is string => typeof candidate === "string" && candidate.trim().length > 0);
  if (candidates.length > 0) return candidates.join(": ");
  return value.stopReason === "error" ? "unknown agent error" : undefined;
}

export function captureUsage(state: MateriaCastState, message: unknown): void {
  const usage = extractUsage(message);
  if (!usage) return;
  const socket = currentSocketId(state) ?? state.phase;
  const materia = state.currentMateria ?? state.phase;
  addUsage(state.runState.usage, usage, { socket, materia, taskId: state.currentItemKey, attempt: currentTaskAttempt(state), materiaModel: state.currentMateriaModel, messageModel: extractMessageModelInfo(message) });
}

export interface ToolScopeRuntimeWarningContext {
  readonly socket?: string;
  readonly materia?: string;
  readonly itemKey?: string;
  readonly visit?: number;
}

export interface ToolScopeRuntimeWarning {
  readonly message: string;
  readonly warnings: readonly string[];
  readonly unavailableTools: readonly string[];
  readonly activeTools: readonly string[];
  readonly configuredTools: readonly string[];
  readonly context: ToolScopeRuntimeWarningContext;
}

export interface UpdateToolScopeOptions {
  readonly context?: ToolScopeRuntimeWarningContext;
  readonly onWarning?: (warning: ToolScopeRuntimeWarning) => void;
  readonly warningScope?: string;
}

const emittedToolScopeWarnings = new WeakMap<ExtensionAPI, Set<string>>();

export function updateToolScope(pi: ExtensionAPI, materia: MateriaAgentConfig, options: UpdateToolScopeOptions = {}): ResolvedToolScope {
  const availableToolNames = pi.getAllTools().map((tool) => tool.name);
  const resolved = resolveToolScope(materia.tools, availableToolNames, "materia.tools");
  if (!resolved.ok) {
    throw new Error(`Invalid materia tool scope: ${resolved.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}`);
  }
  pi.setActiveTools([...resolved.value.activeTools]);
  emitToolScopeWarnings(pi, resolved.value, options);
  return resolved.value;
}

function emitToolScopeWarnings(pi: ExtensionAPI, resolved: ResolvedToolScope, options: UpdateToolScopeOptions): void {
  if (resolved.unavailableTools.length === 0 || resolved.warnings.length === 0 || !options.onWarning) return;
  const context = options.context ?? {};
  const key = options.warningScope ?? [context.socket, context.materia, context.itemKey, context.visit, resolved.unavailableTools.join("\0")].map((part) => String(part ?? "")).join("|");
  let emitted = emittedToolScopeWarnings.get(pi);
  if (!emitted) {
    emitted = new Set<string>();
    emittedToolScopeWarnings.set(pi, emitted);
  }
  if (emitted.has(key)) return;
  emitted.add(key);
  options.onWarning({
    message: formatRuntimeToolScopeWarning(resolved.unavailableTools, context),
    warnings: resolved.warnings,
    unavailableTools: resolved.unavailableTools,
    activeTools: resolved.activeTools,
    configuredTools: resolved.configuredTools,
    context,
  });
}

function formatRuntimeToolScopeWarning(unavailableTools: readonly string[], context: ToolScopeRuntimeWarningContext): string {
  const parts = [
    context.materia ? `materia "${context.materia}"` : undefined,
    context.socket ? `socket "${context.socket}"` : undefined,
  ].filter(Boolean).join(" on ");
  const scope = parts ? ` for ${parts}` : "";
  return `pi-materia tool warning${scope}: skipped unavailable custom tool name(s): ${unavailableTools.join(", ")}. They will be enabled when registered by Pi or an extension.`;
}
