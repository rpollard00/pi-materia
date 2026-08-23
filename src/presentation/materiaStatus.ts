import {
  currentCastSocketId,
  currentCastSocketState,
  runStateCurrentSocketId,
} from "../runtime/castStateAccessors.js";
import {
  loopSockets,
  resolvedPipelineSockets,
} from "../loadout/loadoutAccessors.js";
import { deriveRetryBudget, type MateriaRetryBudget } from "./retryBudget.js";
import {
  parallelLaneNumber,
  summarizeParallelRun,
  type ParallelRunMonitorSummary,
} from "../application/parallelMonitoring.js";
import {
  formatParallelProgressRows,
} from "./parallelProgress.js";
import type {
  MateriaCastState,
  MateriaRunState,
} from "../types.js";
import type {
  MateriaSemanticTheme,
  MateriaThemeRole,
} from "./theme.js";

const WIDGET_MAX_LINE_LENGTH = 78;
export const MATERIA_WIDGET_MAX_LINES = 10;
const MATERIA_BASE_WIDGET_LINES = 3;

/** A state the persistent status widget can render: a bare run or a cast. */
export type MateriaWidgetState = MateriaRunState | MateriaCastState;

export function isMateriaCastWidgetState(
  state: MateriaWidgetState,
): state is MateriaCastState {
  return "runState" in state;
}

export function widgetRunState(state: MateriaWidgetState): MateriaRunState {
  return isMateriaCastWidgetState(state) ? state.runState : state;
}

/**
 * Render the persistent status widget for a run or cast state. Plain by
 * default; pass a theme (and the TUI width) for the themed path. Pure: no
 * widget, session, or ticker state is read or written here.
 */
export function renderMateriaStatus(
  state: MateriaWidgetState,
  options: { now?: number; theme?: MateriaSemanticTheme; width?: number } = {},
): string[] {
  const { theme, width } = options;
  // The themed widget path historically rendered with a fresh timestamp;
  // keep that behavior while plain rendering honors the caller's `now`.
  const now = theme ? Date.now() : (options.now ?? Date.now());
  if (!isMateriaCastWidgetState(state)) {
    return renderMateriaStatusPanel(createMateriaRunStatusModel(state, now), theme);
  }
  const baseLines = renderMateriaStatusPanel(createMateriaCastStatusModel(state, now), theme);
  return appendParallelProgressRows(
    baseLines,
    state,
    theme
      ? Math.min(WIDGET_MAX_LINE_LENGTH, normalizeThemedWidgetWidth(width ?? WIDGET_MAX_LINE_LENGTH))
      : WIDGET_MAX_LINE_LENGTH,
    theme,
  );
}

export function renderMateriaRunWidget(
  state: MateriaRunState,
  now = Date.now(),
): string[] {
  return renderMateriaStatus(state, { now });
}

export function renderMateriaCastStatusWidget(
  state: MateriaCastState,
  now = Date.now(),
): string[] {
  return renderMateriaStatus(state, { now });
}

export function renderConfiguredLoadoutWidget(
  loadoutName: string,
  theme?: MateriaSemanticTheme,
): string[] {
  return renderMateriaStatusPanel(
    createConfiguredLoadoutStatusModel(loadoutName),
    theme,
  );
}

function renderMateriaStatusPanel(
  model: MateriaStatusRenderModel,
  theme?: MateriaSemanticTheme,
): string[] {
  return model.panelLines.map((segments) => renderMateriaStatusLine(segments, model, theme));
}

function renderMateriaStatusLine(
  segments: MateriaStatusSegment[],
  model: MateriaStatusRenderModel,
  theme?: MateriaSemanticTheme,
): string {
  if (segments.length === 1 && segments[0].kind === "message") {
    const segment = segments[0];
    const value = `${segment.label} ${truncateValue(segment.value, WIDGET_MAX_LINE_LENGTH - 2)}`;
    return theme ? theme.fg(statusRoleForSegment(segment, model), value) : truncateLine(value);
  }
  const cells = segments.map((segment) => {
    const value = `${segment.label} ${segment.value}`;
    const cell = segment.width === undefined ? value : fixedCell(value, segment.width);
    // `truncateLine` normalizes whitespace in the plain formatter. Do that
    // before styling so stripping ANSI reproduces the exact transcript row.
    const visibleCell = cell.replace(/\s+/g, " ").trim();
    return theme ? theme.fg(statusRoleForSegment(segment, model), visibleCell) : visibleCell;
  });
  return theme ? cells.join(" ") : truncateLine(cells.join(" "));
}

function statusRoleForSegment(
  segment: MateriaStatusSegment,
  model: MateriaStatusRenderModel,
): MateriaThemeRole {
  if (segment.kind === "cast" || segment.kind === "message") {
    return model.statusRole ?? "text";
  }
  if (segment.kind === "retry") return "warning";
  if (segment.kind === "task") return "text";
  if (segment.kind === "loadout" || segment.kind === "path") return "muted";
  return "dim";
}

export type MateriaStatusSegmentKind =
  | "cast"
  | "loadout"
  | "attempt"
  | "retry"
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
  statusRole?: MateriaThemeRole;
};

const FIRST_LINE_SEGMENTS: Array<{
  kind: MateriaStatusSegmentKind;
  label: string;
  width: number;
  priority: number;
}> = [
  { kind: "cast", label: "✦", width: 10, priority: 80 },
  { kind: "loadout", label: "⌘", width: 29, priority: 100 },
  { kind: "attempt", label: "↻", width: 7, priority: 70 },
  { kind: "retry", label: "⟳", width: 7, priority: 68 },
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
    retry: "-",
    elapsed: formatElapsed(elapsedUntil - state.startedAt),
    usage: `${formatCompactNumber(usage.input + usage.cacheRead)}/${formatCompactNumber(usage.output + usage.cacheWrite)}`,
    task: displayMateriaStatusValue(state, state.currentTask ?? "-"),
    path: "-",
    message: displayMateriaStatusValue(state, state.lastMessage ?? "-"),
  }, state.endedAt === undefined ? "accent" : "success");
}

function createConfiguredLoadoutStatusModel(
  loadoutName: string,
): MateriaStatusRenderModel {
  return createMateriaStatusRenderModel({
    cast: "ready",
    loadout: formatLoadoutMateria(loadoutName || "-", "no active cast"),
    attempt: "-",
    retry: "-",
    elapsed: "-",
    usage: "-",
    task: "active loadout",
    path: "-",
    message: "Ready for the next pi-materia cast.",
  }, "success");
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
    : state.inferenceInterruption
      ? `awaiting nudge after inference interruption: ${state.inferenceInterruption.error}`
      : socketState === "awaiting_user_refinement"
        ? "waiting for refinement; /materia continue to finalize"
        : `${currentMateria ?? state.phase}${state.active ? " active" : ""}`;
  const loop = activeLoopDisplay(state);
  const parallel = activeParallelRun(state);
  const parallelStatus = parallel ? formatParallelRunCompactStatus(parallel) : undefined;
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
    retry: formatRetryBudget(deriveRetryBudget(state)),
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
    message: displayMateriaStatusValue(state.runState, [parallelStatus, status].filter(Boolean).join(" · ")),
  }, materiaCastStatusRole(state, socketState));
}

function materiaCastStatusRole(
  state: MateriaCastState,
  socketState: string,
): MateriaThemeRole {
  if (state.failedReason || state.inferenceInterruption) return "error";
  if (socketState === "awaiting_user_refinement") return "warning";
  if (state.active) return "accent";
  return statusRoleForValue(state.phase);
}

function statusRoleForValue(value: string): MateriaThemeRole {
  const normalized = value.toLowerCase();
  if (/(fail|error|abort|interrupt|cancel)/.test(normalized)) return "error";
  if (/(wait|refin|retry|nudge|queue|pending)/.test(normalized)) return "warning";
  if (/(ready|complete|done|success|accept)/.test(normalized)) return "success";
  if (/(active|run)/.test(normalized)) return "accent";
  return "text";
}

function activeParallelRun(state: MateriaCastState): ParallelRunMonitorSummary | undefined {
  const runs = Object.values(state.parallelRuns ?? {});
  if (runs.length === 0) return undefined;
  const currentSocketId = currentCastSocketId(state);
  const currentLoop = currentSocketId && Object.entries(state.pipeline?.loops ?? {}).find(([, loop]) => loopSockets(loop).includes(currentSocketId))?.[0];
  const selected = currentLoop ? runs.find((run) => run.loopId === currentLoop) : undefined;
  const fallback = runs.slice().sort((left, right) => left.loopId.localeCompare(right.loopId))[0];
  return summarizeParallelRun(selected ?? fallback!);
}

function appendParallelProgressRows(
  baseLines: string[],
  state: MateriaCastState,
  width = WIDGET_MAX_LINE_LENGTH,
  theme?: MateriaSemanticTheme,
): string[] {
  const summary = activeParallelRun(state);
  if (!summary || !isLiveParallelSummary(state, summary)) return baseLines;

  const options = theme ? { theme } : undefined;
  const progressRows = formatParallelProgressRows(summary, width, options);
  const availableRows = MATERIA_WIDGET_MAX_LINES - MATERIA_BASE_WIDGET_LINES;
  if (progressRows.length <= availableRows) return [...baseLines, ...progressRows];

  const visibleRows = progressRows.slice(0, Math.max(0, availableRows - 1));
  const omittedRows = progressRows.length - visibleRows.length;
  const overflowLabel = omittedRows === 1
    ? "… 1 more parallel lane"
    : `… ${omittedRows} more parallel lanes`;
  const boundedOverflow = truncateLine(overflowLabel);
  return [
    ...baseLines,
    ...visibleRows,
    theme ? theme.fg("dim", boundedOverflow) : boundedOverflow,
  ];
}

function isLiveParallelSummary(
  state: MateriaCastState,
  summary: ParallelRunMonitorSummary,
): boolean {
  return state.active
    && (summary.phase === "dispatching" || summary.phase === "awaiting_lanes")
    && summary.fanInPhase === "not_started";
}

/** Compact, bounded aggregate status for the persistent Pi/TUI widget. */
export function formatParallelRunCompactStatus(summary: ParallelRunMonitorSummary): string {
  const { counts } = summary;
  const laneNumbers = summary.lanes
    .map((lane) => parallelLaneNumber(lane.queueIndex))
    .filter((number): number is number => number !== undefined);
  const laneLabel = laneNumbers.length > 0 ? ` lanes:${laneNumbers.join(",")}` : "";
  return `parallel ${summary.loopId}${laneLabel} q${counts.queued} r${counts.running} a${counts.accepted} f${counts.failed} i${counts.interrupted} barrier:${summary.barrier.phase} ${counts.barrierReached}/${counts.total}`;
}

function createMateriaStatusRenderModel(
  values: Record<MateriaStatusSegmentKind, string>,
  statusRole?: MateriaThemeRole,
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
    statusRole,
  };
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
    return socket.materia?.label ?? socket.socket.materia ?? socketId;
  return socketId;
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
    .replace(new RegExp(`\\b${escapedSocketId}\\b`, "g"), materia);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeThemedWidgetWidth(width: number): number {
  if (!Number.isFinite(width)) return WIDGET_MAX_LINE_LENGTH;
  return Math.max(1, Math.floor(width));
}

function formatRetryBudget(budget: MateriaRetryBudget | undefined): string {
  return budget ? `${budget.current}/${budget.max}` : "-";
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

export function formatCompactNumber(value: number): string {
  if (value >= 1_000_000) return `${trimFixed(value / 1_000_000)}m`;
  if (value >= 1_000) return `${trimFixed(value / 1_000)}k`;
  return String(value);
}

function trimFixed(value: number): string {
  return value.toFixed(value >= 10 ? 0 : 1).replace(/\.0$/, "");
}

export function truncateLine(line: string): string {
  return truncateValue(line, WIDGET_MAX_LINE_LENGTH);
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
