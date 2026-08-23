import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { MateriaRunState } from "../types.js";
import {
  createMateriaThemedWidgetFactory,
  supportsThemedWidgets,
} from "./themedWidget.js";
import type { MateriaSemanticTheme } from "./theme.js";
import {
  renderMateriaStatus,
  renderConfiguredLoadoutWidget,
  MATERIA_WIDGET_MAX_LINES,
  widgetRunState,
  isMateriaCastWidgetState,
  type MateriaWidgetState,
} from "./materiaStatus.js";
import { clearMateriaAuxiliaryWidgets } from "./auxiliaryWidgets.js";

type MateriaWidgetController = {
  scope: string;
  ctx: ExtensionContext;
  runId: string;
  identity: string;
  freshness?: number;
  state: MateriaWidgetState;
  lines: string[];
  ticker?: ReturnType<typeof setInterval>;
};
const materiaWidgetControllers = new Map<string, MateriaWidgetController>();
const fallbackWidgetScopes = new WeakMap<ExtensionContext, string>();
let nextFallbackWidgetScope = 1;

/**
 * Publish a run or cast state to the session's persistent status widget.
 *
 * Ownership is per session: the widget follows the current run. A live
 * state from a different run (a cast being started, revived, recast, or
 * restored) takes over; terminal or stale states never do. Returns the
 * rendered lines, or the current owner's lines when the update was
 * ignored.
 */
export function updateWidget(
  ctx: ExtensionContext,
  state: MateriaWidgetState,
): string[] | undefined {
  const runState = widgetRunState(state);
  const scope = getMateriaWidgetScope(ctx);
  const controller = materiaWidgetControllers.get(scope);
  const identity = widgetIdentity(state);
  const freshness = widgetFreshness(state);
  if (
    controller &&
    controller.runId !== runState.runId &&
    runState.endedAt !== undefined
  ) return controller.lines;
  if (
    controller &&
    controller.runId === runState.runId &&
    controller.identity === identity &&
    isOlderFreshness(freshness, controller.freshness)
  ) return controller.lines;

  const replacedController = !controller || controller.runId !== runState.runId || controller.ctx !== ctx;
  const nextController = acceptMateriaWidgetState(scope, ctx, state, identity, freshness);
  if (replacedController) clearMateriaAuxiliaryWidgets(ctx);
  renderMateriaWidgetController(nextController);

  if (runState.endedAt !== undefined) {
    stopMateriaWidgetControllerTicker(nextController, runState.runId);
    return nextController.lines;
  }

  ensureMateriaWidgetControllerTicker(nextController);
  return nextController.lines;
}

export function clearWidgetTicker(ctx: ExtensionContext): void {
  const controller = materiaWidgetControllers.get(getMateriaWidgetScope(ctx));
  if (!controller) return;
  stopMateriaWidgetControllerTicker(controller);
  materiaWidgetControllers.delete(controller.scope);
}

export function syncConfiguredLoadoutWidget(
  ctx: ExtensionContext,
  loadoutName: string,
): boolean {
  const controller = materiaWidgetControllers.get(getMateriaWidgetScope(ctx));
  if (controller && widgetRunState(controller.state).endedAt === undefined) return false;

  if (controller) {
    controller.state = withWidgetLoadout(controller.state, loadoutName);
    renderMateriaWidgetController(controller);
    return true;
  }

  setMateriaWidgetLines(
    ctx,
    renderConfiguredLoadoutWidget(loadoutName),
    (theme) => renderConfiguredLoadoutWidget(loadoutName, theme),
  );
  return true;
}

function acceptMateriaWidgetState(
  scope: string,
  ctx: ExtensionContext,
  state: MateriaWidgetState,
  identity: string,
  freshness: number | undefined,
): MateriaWidgetController {
  const runId = widgetRunState(state).runId;
  const existing = materiaWidgetControllers.get(scope);
  if (existing) {
    existing.ctx = ctx;
    existing.runId = runId;
    existing.identity = identity;
    existing.freshness = freshness;
    existing.state = state;
    return existing;
  }

  const controller: MateriaWidgetController = {
    scope,
    ctx,
    runId,
    identity,
    freshness,
    state,
    lines: [],
  };
  materiaWidgetControllers.set(scope, controller);
  return controller;
}

function renderMateriaWidgetController(controller: MateriaWidgetController): void {
  controller.lines = renderMateriaStatus(controller.state);
  setMateriaWidgetLines(
    controller.ctx,
    controller.lines,
    (theme, width) => renderMateriaStatus(controller.state, { theme, width }),
  );
}

function setMateriaWidgetLines(
  ctx: ExtensionContext,
  lines: string[] | undefined,
  themedRenderer?: (theme: MateriaSemanticTheme, width: number) => readonly string[],
): void {
  const options = { placement: "belowEditor" as const };
  if (themedRenderer && supportsThemedWidgets(ctx)) {
    ctx.ui.setWidget(
      "materia",
      createMateriaThemedWidgetFactory(themedRenderer, {
        maxLines: MATERIA_WIDGET_MAX_LINES,
      }),
      options,
    );
    return;
  }
  ctx.ui.setWidget("materia", lines, options);
}

function ensureMateriaWidgetControllerTicker(controller: MateriaWidgetController): void {
  if (controller.ticker) return;
  const scope = controller.scope;
  const ticker = setInterval(() => {
    const current = materiaWidgetControllers.get(scope);
    if (!current || current.ticker !== ticker) {
      if (!current) clearInterval(ticker);
      return;
    }
    if (widgetRunState(current.state).endedAt !== undefined) {
      stopMateriaWidgetControllerTicker(current);
      return;
    }
    renderMateriaWidgetController(current);
  }, 5000);
  ticker.unref?.();
  controller.ticker = ticker;
}

function stopMateriaWidgetControllerTicker(controller: MateriaWidgetController, runId?: string): void {
  if (runId !== undefined && controller.runId !== runId) return;
  if (controller.ticker) clearInterval(controller.ticker);
  controller.ticker = undefined;
}

function getMateriaWidgetScope(ctx: ExtensionContext): string {
  const sessionManager = (ctx as ExtensionContext & { sessionManager?: MateriaWidgetSessionManager }).sessionManager;
  const sessionFile = readMateriaWidgetSessionValue(() => sessionManager?.getSessionFile?.());
  if (sessionFile) return `materia:session-file:${path.normalize(sessionFile)}`;

  const sessionId = readMateriaWidgetSessionValue(() => sessionManager?.getSessionId?.());
  if (sessionId) return `materia:session-id:${sessionId}`;

  let fallback = fallbackWidgetScopes.get(ctx);
  if (!fallback) {
    fallback = `materia:context:${nextFallbackWidgetScope++}`;
    fallbackWidgetScopes.set(ctx, fallback);
  }
  return fallback;
}

type MateriaWidgetSessionManager = {
  getSessionFile?: () => string | undefined;
  getSessionId?: () => string | undefined;
};

function readMateriaWidgetSessionValue(read: () => unknown): string | undefined {
  try {
    const value = read();
    return typeof value === "string" && value.trim() ? value : undefined;
  } catch {
    return undefined;
  }
}

function widgetIdentity(state: MateriaWidgetState): string {
  if (isMateriaCastWidgetState(state)) return `cast:${state.castId ?? state.runState.runId}`;
  return `run:${state.runId}`;
}

function widgetFreshness(state: MateriaWidgetState): number | undefined {
  if (isMateriaCastWidgetState(state)) return toTimestamp(state.updatedAt) ?? runWidgetFreshness(state.runState);
  return runWidgetFreshness(state);
}

function runWidgetFreshness(state: MateriaRunState): number | undefined {
  return toTimestamp(state.endedAt) ?? toTimestamp((state as MateriaRunState & { updatedAt?: unknown }).updatedAt) ?? toTimestamp(state.startedAt);
}

function toTimestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" || value instanceof Date) {
    const time = new Date(value).getTime();
    return Number.isFinite(time) ? time : undefined;
  }
  return undefined;
}

function isOlderFreshness(incoming: number | undefined, current: number | undefined): boolean {
  if (current === undefined) return false;
  if (incoming === undefined) return true;
  return incoming < current;
}

function withWidgetLoadout(
  state: MateriaWidgetState,
  loadoutName: string,
): MateriaWidgetState {
  if (!isMateriaCastWidgetState(state)) return { ...state, loadoutName };
  return { ...state, runState: { ...state.runState, loadoutName } };
}
