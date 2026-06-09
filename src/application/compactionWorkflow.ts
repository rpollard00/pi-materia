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

/**
 * Content inputs for estimating next-request overhead that is not yet
 * reflected in Pi core's pre-turn ctx.getContextUsage() snapshot.
 */
export interface ContextProjectionInput {
  hiddenPromptContent: string;
  syntheticCastContext: string;
  systemPromptSuffix: string;
}

/** Conservative safety margin (tokens) for provider-specific tokenization variance. */
const SAFETY_MARGIN_TOKENS = 2000;

/** Rough token estimate using chars/4, matching Pi core's fallback heuristic. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface ProjectedOverhead {
  promptTokens: number;
  castContextTokens: number;
  systemPromptTokens: number;
  safetyMarginTokens: number;
  total: number;
}

export async function runSameSocketRecoveryCompaction(ctx: ExtensionContext, state: MateriaCastState): Promise<unknown> {
  return compactContext(ctx, `Pi Materia forced context-window recovery for ${recoveryDiagnosticLabel(state)}. Preserve the active cast state, task requirements, and any durable artifacts/events needed to continue the same turn.`);
}

export interface ContextPressureAssessment {
  shouldCompact: boolean;
  thresholdPercent?: number;
  thresholdMode?: string;
  thresholdTier?: unknown;
  tokens?: number;
  contextWindow?: number;
  percent?: number;
  /** Projected token total after adding next-request overhead (hidden prompt,
   *  synthetic cast context, system-prompt suffix, safety margin). */
  projectedTokens?: number;
  /** Projected percentage of the context window after overhead. */
  projectedPercent?: number;
  /** Breakdown of the projected overhead components. */
  projectedOverhead?: ProjectedOverhead;
}

export async function assessContextPressureForCompaction(
  ctx: ExtensionContext,
  state: MateriaCastState,
  deps: Pick<CompactionWorkflowDeps, "loadConfigFromState">,
  projectedOverheadTokens?: number,
): Promise<ContextPressureAssessment> {
  const usage = ctx.getContextUsage();
  if (!usage) return { shouldCompact: false };
  const config = await deps.loadConfigFromState(state);
  const contextWindow = effectiveContextWindow(ctx, usage);
  const threshold = resolveProactiveCompactionThreshold(config.compaction, contextWindow);
  const thresholdPercent = threshold.thresholdPercent;
  const percent = usage.tokens != null && contextWindow != null && contextWindow > 0 ? (usage.tokens / contextWindow) * 100 : usage.percent;

  const overhead = projectedOverheadTokens ?? 0;
  const projectedTokens = usage.tokens != null ? usage.tokens + overhead : null;
  const projectedPercent = projectedTokens != null && contextWindow != null && contextWindow > 0
    ? (projectedTokens / contextWindow) * 100
    : undefined;

  const rawCrossesThreshold = percent != null && percent >= thresholdPercent;
  const projectedCrossesThreshold = projectedPercent != null && projectedPercent >= thresholdPercent;
  const projectedExceedsWindow = projectedTokens != null && contextWindow != null && contextWindow > 0 && projectedTokens > contextWindow;

  return {
    shouldCompact: rawCrossesThreshold || projectedCrossesThreshold || projectedExceedsWindow,
    thresholdPercent,
    thresholdMode: threshold.mode,
    thresholdTier: threshold.tier,
    tokens: usage.tokens ?? undefined,
    contextWindow,
    percent: percent ?? undefined,
    projectedTokens: projectedTokens ?? undefined,
    projectedPercent,
  };
}

export async function maybeRunProactiveCompactionWorkflow(
  ctx: ExtensionContext,
  state: MateriaCastState,
  deps: CompactionWorkflowDeps,
  projection?: ContextProjectionInput,
): Promise<void> {
  const overhead = projection ? computeProjectedOverhead(projection) : undefined;
  const projectedOverheadTokens = overhead?.total;

  const assessment = await assessContextPressureForCompaction(ctx, state, deps, projectedOverheadTokens);
  if (!assessment.shouldCompact) return;

  const eventBase = {
    action: "compact" as const,
    reason: "context_pressure" as const,
    thresholdPercent: assessment.thresholdPercent,
    thresholdMode: assessment.thresholdMode,
    thresholdTier: assessment.thresholdTier,
    tokens: assessment.tokens,
    contextWindow: assessment.contextWindow,
    percent: assessment.percent,
    ...(assessment.projectedTokens != null ? { projectedTokens: assessment.projectedTokens } : {}),
    ...(assessment.projectedPercent != null ? { projectedPercent: assessment.projectedPercent } : {}),
    ...(overhead ? { projectedOverhead: overhead } : {}),
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

function computeProjectedOverhead(projection: ContextProjectionInput): ProjectedOverhead {
  const promptTokens = estimateTokens(projection.hiddenPromptContent);
  const castContextTokens = estimateTokens(projection.syntheticCastContext);
  const systemPromptTokens = estimateTokens(projection.systemPromptSuffix);
  const safetyMarginTokens = SAFETY_MARGIN_TOKENS;
  return {
    promptTokens,
    castContextTokens,
    systemPromptTokens,
    safetyMarginTokens,
    total: promptTokens + castContextTokens + systemPromptTokens + safetyMarginTokens,
  };
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
