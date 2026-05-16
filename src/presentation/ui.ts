import path from "node:path";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  currentCastSocketId,
  currentCastSocketState,
  runStateCurrentSocketId,
  usageBySocket,
} from "../runtime/castStateAccessors.js";
import {
  loopSockets,
  resolvedPipelineSockets,
} from "../loadout/loadoutAccessors.js";
import type {
  MateriaCastState,
  MateriaRunState,
  UsageCostKind,
  UsageReport,
  UsageTotals,
} from "../types.js";

const WIDGET_MAX_LINE_LENGTH = 78;
type MateriaWidgetState = MateriaRunState | MateriaCastState;
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

export function updateWidget(
  ctx: ExtensionContext,
  state: MateriaWidgetState,
  options: { replaceOwner?: boolean } = {},
): string[] | undefined {
  const runState = widgetRunState(state);
  const scope = getMateriaWidgetScope(ctx);
  const controller = materiaWidgetControllers.get(scope);
  const identity = widgetIdentity(state);
  const freshness = widgetFreshness(state);
  if (controller && controller.runId !== runState.runId && !options.replaceOwner) return controller.lines;
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

  setMateriaWidgetLines(ctx, renderConfiguredLoadoutWidget(loadoutName));
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
  controller.lines = renderMateriaWidgetState(controller.state);
  setMateriaWidgetLines(controller.ctx, controller.lines);
}

function setMateriaWidgetLines(
  ctx: ExtensionContext,
  lines: string[] | undefined,
): void {
  ctx.ui.setWidget("materia", lines, {
    placement: "belowEditor",
  });
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

function isMateriaCastWidgetState(
  state: MateriaWidgetState,
): state is MateriaCastState {
  return "runState" in state;
}

function widgetRunState(state: MateriaWidgetState): MateriaRunState {
  return isMateriaCastWidgetState(state) ? state.runState : state;
}

function renderMateriaWidgetState(
  state: MateriaWidgetState,
  now = Date.now(),
): string[] {
  return isMateriaCastWidgetState(state)
    ? renderMateriaCastStatusWidget(state, now)
    : renderMateriaRunWidget(state, now);
}

function withWidgetLoadout(
  state: MateriaWidgetState,
  loadoutName: string,
): MateriaWidgetState {
  if (!isMateriaCastWidgetState(state)) return { ...state, loadoutName };
  return { ...state, runState: { ...state.runState, loadoutName } };
}

export function renderMateriaRunWidget(
  state: MateriaRunState,
  now = Date.now(),
): string[] {
  return renderMateriaStatusWidget(createMateriaRunStatusModel(state, now));
}

export function renderConfiguredLoadoutWidget(loadoutName: string): string[] {
  return renderMateriaStatusWidget(
    createConfiguredLoadoutStatusModel(loadoutName),
  );
}

export function renderMateriaCastStatusWidget(
  state: MateriaCastState,
  now = Date.now(),
): string[] {
  return renderMateriaStatusWidget(createMateriaCastStatusModel(state, now));
}

export type MateriaStatusSegmentKind =
  | "cast"
  | "loadout"
  | "attempt"
  | "elapsed"
  | "usage"
  | "task"
  | "path"
  | "message";

export type MateriaStatusSegment = {
  kind: MateriaStatusSegmentKind;
  label: string;
  value: string;
  width?: number;
  priority: number;
};

export type MateriaStatusRenderModel = {
  segments: MateriaStatusSegment[];
  panelLines: Array<MateriaStatusSegment[]>;
};

const FIRST_LINE_SEGMENTS: Array<{
  kind: MateriaStatusSegmentKind;
  label: string;
  width: number;
  priority: number;
}> = [
  { kind: "cast", label: "✦", width: 10, priority: 80 },
  { kind: "loadout", label: "⌘", width: 30, priority: 100 },
  { kind: "attempt", label: "↻", width: 7, priority: 70 },
  { kind: "elapsed", label: "◷", width: 8, priority: 75 },
  { kind: "usage", label: "Σ", width: 12, priority: 60 },
];

const SECOND_LINE_SEGMENTS: Array<{
  kind: MateriaStatusSegmentKind;
  label: string;
  width: number;
  priority: number;
}> = [
  { kind: "task", label: "◆", width: 34, priority: 50 },
  { kind: "path", label: "⟲", width: 41, priority: 35 },
];

function createMateriaRunStatusModel(
  state: MateriaRunState,
  now: number,
): MateriaStatusRenderModel {
  const usage = state.usage.tokens;
  const elapsedUntil = state.endedAt ?? now;
  return createMateriaStatusRenderModel({
    cast: state.endedAt === undefined ? "active" : "done",
    loadout: formatLoadoutMateria(state.loadoutName, displayMateriaName(state)),
    attempt: String(state.attempt ?? "-"),
    elapsed: formatElapsed(elapsedUntil - state.startedAt),
    usage: `${formatCompactNumber(usage.input + usage.cacheRead)}/${formatCompactNumber(usage.output + usage.cacheWrite)}`,
    task: displayMateriaStatusValue(state, state.currentTask ?? "-"),
    path: "-",
    message: displayMateriaStatusValue(state, state.lastMessage ?? "-"),
  });
}

function createConfiguredLoadoutStatusModel(
  loadoutName: string,
): MateriaStatusRenderModel {
  return createMateriaStatusRenderModel({
    cast: "ready",
    loadout: formatLoadoutMateria(loadoutName || "-", "no active cast"),
    attempt: "-",
    elapsed: "-",
    usage: "-",
    task: "active loadout",
    path: "-",
    message: "Ready for the next pi-materia cast.",
  });
}

function createMateriaCastStatusModel(
  state: MateriaCastState,
  now: number,
): MateriaStatusRenderModel {
  const currentMateria = state.currentMateria ?? state.runState.currentMateria;
  const socketState =
    currentCastSocketState(state) ??
    (state.awaitingResponse
      ? "awaiting_agent_response"
      : state.active
        ? "idle"
        : state.phase);
  const status = state.failedReason
    ? `failed: ${state.failedReason}`
    : socketState === "awaiting_user_refinement"
      ? "waiting for refinement; /materia continue to finalize"
      : `${currentMateria ?? state.phase}${state.active ? " active" : ""}`;
  const loop = activeLoopDisplay(state);
  return createMateriaStatusRenderModel({
    cast: state.active ? "active" : state.phase || "done",
    loadout: formatLoadoutMateria(
      state.runState.loadoutName,
      displayMateriaName(
        state.runState,
        currentMateria ?? currentCastSocketId(state),
      ),
    ),
    attempt: loop?.turn ?? String(state.runState.attempt ?? "-"),
    elapsed: formatElapsed(
      (state.runState.endedAt ?? now) - state.runState.startedAt,
    ),
    usage: `${formatCompactNumber(state.runState.usage.tokens.input + state.runState.usage.tokens.cacheRead)}/${formatCompactNumber(state.runState.usage.tokens.output + state.runState.usage.tokens.cacheWrite)}`,
    task: displayMateriaStatusValue(
      state.runState,
      state.currentItemLabel ??
        state.runState.currentTask ??
        state.request ??
        "-",
    ),
    path: loop?.path ?? "-",
    message: displayMateriaStatusValue(state.runState, status),
  });
}

function createMateriaStatusRenderModel(
  values: Record<MateriaStatusSegmentKind, string>,
): MateriaStatusRenderModel {
  const firstLine = FIRST_LINE_SEGMENTS.map((definition) => ({
    ...definition,
    value: values[definition.kind],
  }));
  const secondLine = SECOND_LINE_SEGMENTS.map((definition) => ({
    ...definition,
    value: values[definition.kind],
  }));
  const message: MateriaStatusSegment = {
    kind: "message",
    label: "›",
    value: values.message,
    priority: 40,
  };
  return {
    segments: [...firstLine, ...secondLine, message],
    panelLines: [firstLine, secondLine, [message]],
  };
}

function renderMateriaStatusWidget(model: MateriaStatusRenderModel): string[] {
  return model.panelLines.map((segments) => renderMateriaStatusLine(segments));
}

function renderMateriaStatusLine(segments: MateriaStatusSegment[]): string {
  if (segments.length === 1 && segments[0].kind === "message") {
    return truncateLine(
      `${segments[0].label} ${truncateValue(segments[0].value, WIDGET_MAX_LINE_LENGTH - 2)}`,
    );
  }
  const cells = segments.map((segment) => {
    const value = `${segment.label} ${segment.value}`;
    return segment.width === undefined
      ? value
      : fixedCell(value, segment.width);
  });
  return truncateLine(joinCells(cells));
}

export function updateMateriaWebUiStatusWidget(
  ctx: ExtensionContext,
  input: { url: string; status: "started" | "reused" },
): void {
  ctx.ui.setWidget("materia-webui", renderMateriaWebUiStatusWidget(input), {
    placement: "belowEditor",
  });
}

export function renderMateriaWebUiStatusWidget(input: {
  url: string;
  status: "started" | "reused";
}): string[] {
  const state = input.status === "reused" ? "ready (reused)" : "started";
  return [`WebUI ${state}: ${truncateLine(input.url)}`];
}

export function clearMateriaAuxiliaryWidgets(ctx: ExtensionContext): void {
  for (const key of [
    "materia-loadouts",
    "materia-status",
    "materia-casts",
    "materia-usage",
    "materia-grid",
  ] as const) {
    ctx.ui.setWidget(key, undefined, { placement: "belowEditor" });
  }
}

export function showUsageSummary(
  ctx: ExtensionContext,
  state: MateriaRunState,
): void {
  ctx.ui.setWidget("materia-usage", renderCompactUsageWidget(state.usage), {
    placement: "belowEditor",
  });
}

export function renderCompactUsageWidget(usage: UsageReport): string[] {
  return [`Usage total ${formatCompactNumber(usage.tokens.total)} tokens`];
}

export function renderUsageSummary(usage: UsageReport): string[] {
  return [
    "Materia Usage Summary",
    usageCostNote(usage.costKind),
    `total: ${formatUsage(usage, usage.costKind)}`,
    "",
    "By materia:",
    ...renderBreakdown(usage.byMateria, usage.costKind),
    "",
    "By socket:",
    ...renderBreakdown(usageBySocket(usage), usage.costKind),
    "",
    "By task:",
    ...renderBreakdown(usage.byTask, usage.costKind),
  ];
}

function renderBreakdown(
  values: Record<string, UsageTotals>,
  costKind: UsageCostKind = "actual",
): string[] {
  const entries = Object.entries(values);
  if (entries.length === 0) return ["- none observed"];
  return entries
    .sort(([, a], [, b]) => b.tokens.total - a.tokens.total)
    .map(([key, usage]) => `- ${key}: ${formatUsage(usage, costKind)}`);
}

export function formatUsage(
  usage: UsageTotals,
  costKind: UsageCostKind = "actual",
): string {
  if (costKind === "subscription" && usage.cost.total === 0) {
    return `${usage.tokens.total} tokens, no per-token billing (subscription)`;
  }
  return `${usage.tokens.total} tokens, ${formatCostLabel(usage.cost.total, costKind)}`;
}

export function formatCostLabel(
  costUsd: number,
  costKind: UsageCostKind = "actual",
): string {
  if (costKind === "subscription")
    return `estimated token value: $${costUsd.toFixed(4)} (subscription; no per-token billing implied)`;
  if (costKind === "estimated")
    return `estimated USD value: $${costUsd.toFixed(4)}`;
  return `billed cost: $${costUsd.toFixed(4)}`;
}

export function usageCostNote(costKind: UsageCostKind = "actual"): string {
  if (costKind === "subscription")
    return "Cost display: estimated token value only; subscription usage is not billed per token.";
  if (costKind === "estimated")
    return "Cost display: estimated USD value, not confirmed billed charges.";
  return "Cost display: billed USD cost.";
}

function displayMateriaName(state: MateriaRunState, override?: string): string {
  return (
    override ?? state.currentMateria ?? runStateCurrentSocketId(state) ?? "-"
  );
}

function formatLoadoutMateria(
  loadoutName: string | undefined,
  materiaName: string,
): string {
  return `${loadoutName || "-"} ◉ ${materiaName || "-"}`;
}

function activeLoopDisplay(
  state: MateriaCastState,
): { turn: string; path: string } | undefined {
  const currentSocketId = currentCastSocketId(state);
  if (!currentSocketId || !state.pipeline) return undefined;
  const loop = Object.values(state.pipeline.loops ?? {}).find((candidate) =>
    loopSockets(candidate).includes(currentSocketId),
  );
  if (!loop) return undefined;

  const cursor =
    loop.iterator?.cursor ?? loop.consumes?.cursor ?? `${currentSocketId}Index`;
  const currentIndex = Math.max(0, state.cursors[cursor] ?? 0);
  const total = loop.iterator
    ? resolveLoopTotal(state, loop.iterator.items)
    : undefined;
  return {
    turn:
      total === undefined
        ? `${currentIndex + 1}/?`
        : `${Math.min(currentIndex + 1, total)}/${total}`,
    path: loopSockets(loop)
      .map((socketId) =>
        socketId === currentSocketId
          ? `[${displayPipelineSocketName(state, socketId)}]`
          : displayPipelineSocketName(state, socketId),
      )
      .join(" -> "),
  };
}

function displayPipelineSocketName(
  state: MateriaCastState,
  socketId: string,
): string {
  const socket = resolvedPipelineSockets(state.pipeline)[socketId];
  if (!socket) return socketId;
  if ("materia" in socket)
    return socket.materia.label ?? socket.socket.materia ?? socketId;
  return socket.socket.utility ?? socket.socket.command?.[0] ?? socketId;
}

function resolveLoopTotal(
  state: MateriaCastState,
  itemsPath: string,
): number | undefined {
  const items = resolveDisplayPath(state, itemsPath);
  return Array.isArray(items) ? items.length : undefined;
}

function resolveDisplayPath(
  state: MateriaCastState,
  expression: string,
): unknown {
  const trimmed = expression.trim();
  if (trimmed.startsWith("state."))
    return getDisplayPath(state.data, trimmed.slice("state.".length));
  if (trimmed.startsWith("cursor."))
    return state.cursors[trimmed.slice("cursor.".length)];
  return undefined;
}

function getDisplayPath(value: unknown, path: string): unknown {
  return path
    .split(".")
    .filter(Boolean)
    .reduce<unknown>((current, part) => {
      if (current && typeof current === "object" && part in current)
        return (current as Record<string, unknown>)[part];
      return undefined;
    }, value);
}

function displayMateriaStatusValue(
  state: MateriaRunState,
  value: string,
): string {
  const socketId = runStateCurrentSocketId(state);
  const materia = state.currentMateria;
  if (!socketId || !materia || socketId === materia) return value;
  const normalized = value.trim();
  if (normalized === socketId) return materia;
  const escapedSocketId = escapeRegExp(socketId);
  return value
    .replace(new RegExp(`socket\\s+"${escapedSocketId}"`, "g"), materia)
    .replace(new RegExp(`socket\\s+${escapedSocketId}`, "g"), materia)
    .replace(new RegExp(`socket\\s+"${escapedSocketId}"`, "g"), materia)
    .replace(new RegExp(`socket\\s+${escapedSocketId}`, "g"), materia)
    .replace(new RegExp(`\\b${escapedSocketId}\\b`, "g"), materia);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function formatElapsed(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h${minutes.toString().padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m${seconds.toString().padStart(2, "0")}s`;
  return `${seconds}s`;
}

function formatCompactNumber(value: number): string {
  if (value >= 1_000_000) return `${trimFixed(value / 1_000_000)}m`;
  if (value >= 1_000) return `${trimFixed(value / 1_000)}k`;
  return String(value);
}

function trimFixed(value: number): string {
  return value.toFixed(value >= 10 ? 0 : 1).replace(/\.0$/, "");
}

function truncateLine(line: string): string {
  return truncateValue(line, WIDGET_MAX_LINE_LENGTH);
}

function joinCells(cells: string[]): string {
  return cells.join(" ").trimEnd();
}

function fixedCell(value: string, width: number): string {
  const truncated = truncateValue(value, width);
  return truncated.padEnd(width, " ");
}

function truncateValue(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  if (maxLength <= 1) return "…".slice(0, maxLength);
  return `${normalized.slice(0, maxLength - 1)}…`;
}
