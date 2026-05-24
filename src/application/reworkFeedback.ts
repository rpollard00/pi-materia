import { HANDOFF_CONTEXT_FIELD } from "../handoff/handoffContract.js";
import { resolvedMateriaDisplayName, resolvedMateriaId } from "../runtime/resolvedMateria.js";
import type { MateriaCastState, MateriaEdgeConfig, ResolvedMateriaSocket } from "../types.js";
import { isPlainObject } from "./workflowTransitions.js";

const MAX_REWORK_FEEDBACK_ENTRIES = 5;
const MAX_REASON_CHARS = 900;
const MAX_OUTPUT_CHARS = 900;
const MAX_RENDER_CHARS = 2_400;

export interface CaptureReworkFeedbackInput {
  sourceSocket: ResolvedMateriaSocket;
  targetSocketId: string;
  edge: MateriaEdgeConfig;
  parsed: unknown;
  rawOutput: string;
}

export function captureReworkFeedbackForRoute(state: MateriaCastState, input: CaptureReworkFeedbackInput): void {
  if (input.edge.when !== "not_satisfied") return;

  const reason = conciseReasonText(input.parsed, input.rawOutput);
  const entries = state.reworkFeedback ?? [];
  const next = [
    ...entries,
    {
      sourceSocketId: input.sourceSocket.id,
      sourceMateria: resolvedMateriaId(input.sourceSocket),
      sourceMateriaLabel: resolvedMateriaDisplayName(input.sourceSocket),
      targetSocketId: input.targetSocketId,
      condition: "not_satisfied" as const,
      itemKey: state.currentItemKey,
      itemLabel: state.currentItemLabel,
      reason,
      createdAt: Date.now(),
    },
  ];
  state.reworkFeedback = next.slice(-MAX_REWORK_FEEDBACK_ENTRIES);
}

export function renderReworkFeedbackPromptContext(state: MateriaCastState, targetSocketId: string): string | undefined {
  const matching = (state.reworkFeedback ?? []).filter((entry) => {
    if (entry.targetSocketId !== targetSocketId) return false;
    if (entry.itemKey && state.currentItemKey && entry.itemKey !== state.currentItemKey) return false;
    if (entry.itemKey && !state.currentItemKey) return false;
    return true;
  });
  if (matching.length === 0) return undefined;

  const lines = [
    "Runtime follow-up context:",
    "This socket was reached by prior not_satisfied routing, so treat the current turn as follow-up/rework for the current item. Use the prior reason text below as actionable context when it applies, even if the workItem title is vague.",
    ...matching.map((entry) => {
      const source = [entry.sourceSocketId, entry.sourceMateriaLabel ?? entry.sourceMateria].filter(Boolean).join(" ");
      const item = entry.itemLabel ? ` for ${entry.itemLabel}` : "";
      return `- From ${source || "previous socket"}${item}: ${entry.reason}`;
    }),
  ];
  return truncateText(lines.join("\n"), MAX_RENDER_CHARS);
}

function conciseReasonText(parsed: unknown, rawOutput: string): string {
  const context = isPlainObject(parsed) ? parsed[HANDOFF_CONTEXT_FIELD] : undefined;
  if (typeof context === "string" && context.trim()) return truncateText(normalizeWhitespace(context), MAX_REASON_CHARS);
  const output = normalizeWhitespace(rawOutput);
  return output ? `No top-level context was provided; bounded previous output excerpt: ${truncateText(output, MAX_OUTPUT_CHARS)}` : "No top-level context or output text was provided by the prior socket.";
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}
