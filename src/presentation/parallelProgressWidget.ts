import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { MateriaCastState, MateriaParallelRunState } from "../types.js";
import { summarizeParallelRun, type ParallelRunMonitorSummary } from "../application/parallelMonitoring.js";
import {
  DEFAULT_PARALLEL_PROGRESS_WIDTH,
  formatParallelProgressRows,
} from "./parallelProgress.js";

export const PARALLEL_PROGRESS_WIDGET_KEY = "materia-parallel-progress";

type ProgressController = {
  scope: string;
  ctx: ExtensionContext;
  runId: string;
  summary: ParallelRunMonitorSummary;
};

const ownersByScope = new Map<string, ProgressController>();
const controllersByRun = new Map<string, ProgressController>();
const fallbackScopes = new WeakMap<ExtensionContext, string>();
let nextFallbackScope = 1;

/** Mount a separately anchored, Pi-managed string-row widget for a newly owned run. */
export function mountParallelProgressWidget(ctx: ExtensionContext, run: MateriaParallelRunState): void {
  const summary = summarizeParallelRun(run);
  if (!isLive(summary)) {
    clearParallelProgressWidget(ctx, run.runId);
    return;
  }

  const scope = progressWidgetScope(ctx);
  const previous = ownersByScope.get(scope);
  if (previous?.runId === run.runId && previous.ctx === ctx) {
    applySummary(previous, summary);
    return;
  }
  if (previous) controllersByRun.delete(previous.runId);

  const controller: ProgressController = { scope, ctx, runId: run.runId, summary };
  ownersByScope.set(scope, controller);
  controllersByRun.set(run.runId, controller);
  publishSummary(controller);
}

/** Apply a coordinator checkpoint only when the callback still owns this run. */
export function refreshParallelProgressWidget(run: MateriaParallelRunState): boolean {
  const controller = controllersByRun.get(run.runId);
  if (!controller || ownersByScope.get(controller.scope) !== controller) return false;
  const summary = summarizeParallelRun(run);
  if (!isLive(summary)) {
    clearParallelProgressWidget(controller.ctx, run.runId);
    return true;
  }
  applySummary(controller, summary);
  return true;
}

/** Clear only the named owner, preventing delayed callbacks from clearing a successor. */
export function clearParallelProgressWidget(ctx: ExtensionContext, runId?: string): boolean {
  const scope = progressWidgetScope(ctx);
  const controller = ownersByScope.get(scope);
  if (!controller || (runId !== undefined && controller.runId !== runId)) return false;
  ownersByScope.delete(scope);
  controllersByRun.delete(controller.runId);
  ctx.ui.setWidget(PARALLEL_PROGRESS_WIDGET_KEY, undefined, { placement: "belowEditor" });
  return true;
}

/** Restore or reconcile the live Pi-managed rows from a persisted cast snapshot. */
export function syncParallelProgressWidgetFromCast(ctx: ExtensionContext, state: MateriaCastState): void {
  const castTerminal = state.active === false
    || state.phase === "failed"
    || state.phase === "complete"
    || state.socketState === "failed"
    || state.socketState === "complete"
    || state.failedReason !== undefined;
  const live = castTerminal
    ? undefined
    : Object.values(state.parallelRuns ?? {})
      .filter((run) => isLive(summarizeParallelRun(run)))
      .sort((left, right) => left.runId.localeCompare(right.runId))[0];
  const owner = ownersByScope.get(progressWidgetScope(ctx));
  if (live) {
    if (!owner || owner.ctx !== ctx || owner.runId !== live.runId) mountParallelProgressWidget(ctx, live);
    else refreshParallelProgressWidget(live);
    return;
  }
  if (owner) clearParallelProgressWidget(ctx, owner.runId);
}

function progressWidgetScope(ctx: ExtensionContext): string {
  const sessionManager = (ctx as ExtensionContext & {
    sessionManager?: { getSessionFile?: () => string | undefined; getSessionId?: () => string | undefined };
  }).sessionManager;
  for (const read of [sessionManager?.getSessionFile, sessionManager?.getSessionId]) {
    try {
      const value = read?.call(sessionManager);
      if (typeof value === "string" && value.trim()) return `session:${value}`;
    } catch { /* fall through to the context identity */ }
  }
  let scope = fallbackScopes.get(ctx);
  if (!scope) {
    scope = `context:${nextFallbackScope++}`;
    fallbackScopes.set(ctx, scope);
  }
  return scope;
}

function applySummary(controller: ProgressController, summary: ParallelRunMonitorSummary): void {
  controller.summary = summary;
  publishSummary(controller);
}

function publishSummary(controller: ProgressController): void {
  // `setWidget` owns the widget lifecycle and redraw. Publishing a fresh row
  // snapshot also makes rewinds visible instead of leaving a retained
  // component with stale state behind.
  controller.ctx.ui.setWidget(
    PARALLEL_PROGRESS_WIDGET_KEY,
    formatParallelProgressRows(controller.summary, DEFAULT_PARALLEL_PROGRESS_WIDTH),
    { placement: "belowEditor" },
  );
}

function isLive(summary: ParallelRunMonitorSummary): boolean {
  return (summary.phase === "dispatching" || summary.phase === "awaiting_lanes")
    && summary.fanInPhase === "not_started";
}

