import type { ExtensionAPI, SessionEntry } from "@mariozechner/pi-coding-agent";
import type { MateriaAgentConfig, MateriaCastState } from "../types.js";
import { resolveToolScope } from "../domain/toolScope.js";
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

export function updateToolScope(pi: ExtensionAPI, materia: MateriaAgentConfig): void {
  const availableToolNames = pi.getAllTools().map((tool) => tool.name);
  const resolved = resolveToolScope(materia.tools, availableToolNames, "materia.tools");
  if (!resolved.ok) {
    throw new Error(`Invalid materia tool scope: ${resolved.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}`);
  }
  pi.setActiveTools([...resolved.value.tools]);
}
