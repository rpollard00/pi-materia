import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { MateriaCastState, MateriaParallelRunState } from "../types.js";
import { summarizeParallelRun, type ParallelRunMonitorSummary } from "../application/parallelMonitoring.js";
import { ParallelProgressComponent, type ParallelProgressPart } from "./parallelProgress.js";

export const PARALLEL_PROGRESS_WIDGET_KEY = "materia-parallel-progress";

type ProgressController = {
  scope: string;
  ctx: ExtensionContext;
  runId: string;
  summary: ParallelRunMonitorSummary;
  component?: ParallelProgressComponent;
  requestRender?: () => void;
};

const ownersByScope = new Map<string, ProgressController>();
const controllersByRun = new Map<string, ProgressController>();
const fallbackScopes = new WeakMap<ExtensionContext, string>();
let nextFallbackScope = 1;

/** Mount a non-focusable, separately anchored widget for a newly owned run. */
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
  ctx.ui.setWidget(PARALLEL_PROGRESS_WIDGET_KEY, (tui, theme) => {
    // The component has no handleInput method and therefore cannot steal focus
    // from the editor while a slash command is being entered.
    const component = new ParallelProgressComponent(controller.summary.lanes, {
      style: (text, status, part) => theme.fg(progressColor(status, part), text),
    });
    controller.component = component;
    controller.requestRender = () => tui.requestRender();
    return component;
  }, { placement: "belowEditor" });
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
  controller.requestRender = undefined;
  controller.component = undefined;
  ctx.ui.setWidget(PARALLEL_PROGRESS_WIDGET_KEY, undefined, { placement: "belowEditor" });
  return true;
}

/**
 * Normal status-widget updates/ticks provide a low-frequency fallback redraw
 * if a host does not expose the widget factory's requestRender callback.
 */
export function syncParallelProgressWidgetFromCast(ctx: ExtensionContext, state: MateriaCastState): void {
  const live = state.socketState === "running_parallel"
    ? Object.values(state.parallelRuns ?? {}).find((run) => isLive(summarizeParallelRun(run)))
    : undefined;
  const owner = ownersByScope.get(progressWidgetScope(ctx));
  if (live) {
    if (!owner || owner.ctx !== ctx) mountParallelProgressWidget(ctx, live);
    else if (owner.runId === live.runId) refreshParallelProgressWidget(live);
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
  controller.component?.setLanes(summary.lanes);
  controller.requestRender?.();
}

function isLive(summary: ParallelRunMonitorSummary): boolean {
  return (summary.phase === "dispatching" || summary.phase === "awaiting_lanes")
    && summary.fanInPhase === "not_started";
}

function progressColor(
  status: ParallelRunMonitorSummary["lanes"][number]["status"],
  part: ParallelProgressPart,
): "accent" | "muted" | "success" | "error" | "warning" | "dim" | "text" {
  if (part === "name" || part === "detail") return status === "queued" ? "dim" : "text";
  switch (status) {
    case "accepted": return "success";
    case "failed": return "error";
    case "interrupted": return "warning";
    case "queued": return "dim";
    case "running": return "accent";
  }
}
