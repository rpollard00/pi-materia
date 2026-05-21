import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { MateriaAgentConfig, MateriaCastState } from "../types.js";
import { resolveToolScope, type ResolvedToolScope } from "../domain/toolScope.js";
import { addUsage, extractMessageModelInfo, extractUsage } from "../telemetry/usage.js";
import { currentSocketId, currentTaskAttempt } from "./sessionState.js";

export function findLatestAssistantEntry(entries: SessionEntry[], afterId?: string): { entry: SessionEntry; message: unknown } | undefined {
  const afterIndex = afterId ? entries.findIndex((e) => e.id === afterId) : -1;
  for (let i = entries.length - 1; i > afterIndex; i--) {
    const entry = entries[i];
    if (entry.type === "message" && (entry.message as any).role === "assistant") return { entry, message: entry.message };
  }
  return undefined;
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
