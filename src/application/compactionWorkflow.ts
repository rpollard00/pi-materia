import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveProactiveCompactionThreshold } from "../config/compactionConfig.js";
import type { MateriaCastState, PiMateriaConfig } from "../types.js";
import { errorMessage, recoveryDiagnosticLabel, recoveryTurnMode } from "./recoveryPolicy.js";

export interface CompactionWorkflowDeps {
  loadConfigFromState(state: MateriaCastState): Promise<PiMateriaConfig>;
  appendEvent(runState: MateriaCastState["runState"], type: string, data: Record<string, unknown>): Promise<void>;
  writeUsage(runState: MateriaCastState["runState"]): Promise<void>;
  saveState(state: MateriaCastState): void;
  notifyWarning(message: string): void;
  currentSocketId(state: MateriaCastState): string | undefined;
  currentSocketVisit(state: MateriaCastState, fallback?: number): number;
  shortMetadataLabel(value: string | undefined): string | undefined;
}

export async function runSameSocketRecoveryCompaction(ctx: ExtensionContext, state: MateriaCastState): Promise<unknown> {
  return compactContext(ctx, `Pi Materia forced context-window recovery for ${recoveryDiagnosticLabel(state)}. Preserve the active cast state, task requirements, and any durable artifacts/events needed to continue the same turn.`);
}

export async function maybeRunProactiveCompactionWorkflow(ctx: ExtensionContext, state: MateriaCastState, deps: CompactionWorkflowDeps): Promise<void> {
  const usage = ctx.getContextUsage();
  if (!usage) return;
  const config = await deps.loadConfigFromState(state);
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
    socket: deps.currentSocketId(state),
    itemKey: state.currentItemKey,
    itemLabel: state.currentItemLabel,
    itemLabelShort: deps.shortMetadataLabel(state.currentItemLabel),
    visit: deps.currentSocketVisit(state, undefined),
    mode: recoveryTurnMode(state),
  };
  await deps.appendEvent(state.runState, "proactive_compaction_start", eventBase);
  deps.saveState(state);

  try {
    const result = await compactContext(ctx, `Pi Materia proactive context-pressure compaction before ${recoveryDiagnosticLabel(state)}. Preserve the active cast state, task requirements, and any durable artifacts/events needed to continue the same turn.`);
    await deps.appendEvent(state.runState, "proactive_compaction_complete", { ...eventBase, result: summarizeCompactionResult(result) });
    deps.saveState(state);
  } catch (error) {
    const message = `Proactive compaction failed before ${recoveryDiagnosticLabel(state)}; continuing turn so same-socket recovery can handle any later context-window failure: ${errorMessage(error)}`;
    state.runState.lastMessage = message;
    await deps.appendEvent(state.runState, "proactive_compaction_failed", { ...eventBase, error: errorMessage(error), warning: true });
    await deps.writeUsage(state.runState);
    deps.saveState(state);
    deps.notifyWarning(`pi-materia warning: ${message}`);
  }
}

export function compactContext(ctx: ExtensionContext, customInstructions: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    try {
      ctx.compact({ customInstructions, onComplete: resolve, onError: reject });
    } catch (error) {
      reject(error);
    }
  });
}

export function summarizeCompactionResult(result: unknown): unknown {
  if (!result || typeof result !== "object") return result;
  const value = result as Record<string, unknown>;
  return Object.fromEntries(Object.entries(value).filter(([key]) => ["tokensBefore", "tokensAfter", "entriesRemoved", "summaryTokens", "firstKeptEntryId"].includes(key)));
}

function effectiveContextWindow(ctx: ExtensionContext, usage: { contextWindow?: number }): number | undefined {
  const modelContextWindow = ctx.model?.contextWindow;
  if (Number.isFinite(modelContextWindow) && modelContextWindow != null && modelContextWindow > 0) return modelContextWindow;
  return Number.isFinite(usage.contextWindow) && usage.contextWindow != null && usage.contextWindow > 0 ? usage.contextWindow : undefined;
}
