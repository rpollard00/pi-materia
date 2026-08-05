import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type {
  ParallelLaneMonitorSummary,
  ParallelRunMonitorSummary,
} from "../application/parallelMonitoring.js";

export type ParallelProgressPart = "aggregate" | "bar" | "name" | "stage" | "detail" | "status";

export interface ParallelProgressFormatOptions {
  /** Optional late-bound theming. The formatter remains ANSI-width aware. */
  style?: (
    text: string,
    status: ParallelLaneMonitorSummary["status"],
    part: ParallelProgressPart,
  ) => string;
  maxBarWidth?: number;
  /** Render the coordinator's running-slot aggregate when supplied. */
  maxConcurrency?: number;
}

type ProgressLane = Pick<
  ParallelLaneMonitorSummary,
  "laneId" | "name" | "streamIndex" | "queueIndex" | "status" | "progress" | "activeStage"
>;
type ParallelProgressInput =
  | readonly ProgressLane[]
  | Pick<ParallelRunMonitorSummary, "lanes" | "maxConcurrency">;

const DEFAULT_MAX_BAR_WIDTH = 20;
/** Width used when rows are handed to Pi without a component render callback. */
export const DEFAULT_PARALLEL_PROGRESS_WIDTH = 80;

/**
 * Render bounded, non-empty rows without mutating the monitor DTO. When a
 * concurrency bound is supplied, the first row is the coordinator slot summary;
 * lane rows follow in streamIndex order with stable persisted fields as
 * tie-breakers.
 *
 * Pi's string-row widget API does not provide a render width. Callers can use
 * the default width (or {@link formatParallelProgressRows}) and let Pi's Text
 * wrapper handle the final terminal-width wrapping.
 */
export function formatParallelProgress(
  input: ParallelProgressInput,
  width: number = DEFAULT_PARALLEL_PROGRESS_WIDTH,
  options: ParallelProgressFormatOptions = {},
): string[] {
  const boundedWidth = normalizeWidth(width);
  const { lanes, maxConcurrency } = normalizeProgressInput(input, options);
  const rows = [...lanes]
    .sort(compareScheduleOrder)
    .map((lane) => formatLane(lane, boundedWidth, options) || compactFallback(lane));

  if (maxConcurrency !== undefined) {
    rows.unshift(formatAggregateRow(lanes, boundedWidth, maxConcurrency, options));
  }
  return rows;
}

/**
 * Format rows for `ctx.ui.setWidget`'s string-array form. Keeping this as a
 * pure helper means every checkpoint can publish a fresh snapshot, including
 * rewinds, without retaining a custom TUI component.
 */
export function formatParallelProgressRows(
  input: ParallelProgressInput,
  width: number = DEFAULT_PARALLEL_PROGRESS_WIDTH,
  options: ParallelProgressFormatOptions = {},
): string[] {
  return formatParallelProgress(input, width, options);
}

/**
 * @deprecated Prefer `formatParallelProgressRows` with Pi-managed widget rows.
 * This adapter remains for older callers but is no longer required for live
 * invalidation or rewind support.
 */
export class ParallelProgressComponent implements Component {
  private lanes: ParallelProgressInput;

  constructor(
    lanes: ParallelProgressInput,
    private readonly options: ParallelProgressFormatOptions = {},
  ) {
    this.lanes = lanes;
  }

  setLanes(lanes: ParallelProgressInput): void {
    this.lanes = lanes;
  }

  render(width: number): string[] {
    return formatParallelProgress(this.lanes, width, this.options);
  }

  invalidate(): void {
    // Rendering is pure and uncached; a theme callback is evaluated on every render.
  }
}

function formatLane(
  lane: ProgressLane,
  width: number,
  options: ParallelProgressFormatOptions,
): string {
  if (width === 0) return "";

  const { position, total } = boundedProgress(lane.progress);
  const percentage = total === 0 ? 0 : Math.floor((position / total) * 100);
  const status = statusLabel(lane.status);
  const detail = `${percentage}% (${position}/${total})`;
  const name = safeName(lane.name, lane.laneId);
  const stage = stageLabel(lane);
  const maxBarWidth = Number.isFinite(options.maxBarWidth)
    ? Math.max(1, Math.floor(options.maxBarWidth ?? DEFAULT_MAX_BAR_WIDTH))
    : DEFAULT_MAX_BAR_WIDTH;

  // Reserve room for the name and all progress/state details before growing the
  // bar. This keeps terminal labels visible on moderately narrow terminals.
  const nonBarWidth = 1 + visibleWidth(detail) + 1 + visibleWidth(status) + 3;
  const desiredBarWidth = Math.min(maxBarWidth, Math.max(1, Math.floor(width / 4)));
  const barWidth = Math.max(1, Math.min(desiredBarWidth, width - nonBarWidth - 1));
  const bar = progressBar(position, total, barWidth);
  const fixedWidth = visibleWidth(bar) + visibleWidth(detail) + visibleWidth(status)
    + (stage ? 4 : 3);
  const flexibleWidth = Math.max(0, width - fixedWidth);
  const stageWidth = stage
    ? Math.max(1, Math.min(visibleWidth(stage), Math.floor(flexibleWidth / 2)))
    : 0;
  const nameWidth = Math.max(1, flexibleWidth - stageWidth);
  const boundedName = truncateToWidth(name, nameWidth, "…");
  const boundedStage = stage ? truncateToWidth(stage, stageWidth, "…") : undefined;
  const style = options.style ?? ((text: string) => text);

  const line = [
    style(bar, lane.status, "bar"),
    style(boundedName, lane.status, "name"),
    ...(boundedStage ? [style(boundedStage, lane.status, "stage")] : []),
    style(detail, lane.status, "detail"),
    style(status, lane.status, "status"),
  ].join(" ");
  return truncateToWidth(line, width, "");
}

function normalizeProgressInput(
  input: ParallelProgressInput,
  options: ParallelProgressFormatOptions,
): { lanes: readonly ProgressLane[]; maxConcurrency?: number } {
  if (isLaneArray(input)) {
    return { lanes: input, maxConcurrency: validMaxConcurrency(options.maxConcurrency) };
  }
  return {
    lanes: input.lanes,
    maxConcurrency: validMaxConcurrency(options.maxConcurrency) ?? validMaxConcurrency(input.maxConcurrency),
  };
}

function isLaneArray(input: ParallelProgressInput): input is readonly ProgressLane[] {
  return Array.isArray(input);
}

function formatAggregateRow(
  lanes: readonly ProgressLane[],
  width: number,
  maxConcurrency: number,
  options: ParallelProgressFormatOptions,
): string {
  const running = lanes.filter((lane) => lane.status === "running").length;
  const full = `Parallel slots: ${running}/${maxConcurrency} running`;
  // Preserve the useful occupancy ratio on narrow terminals instead of letting
  // a long heading truncate away both counts.
  const compact = `Slots ${running}/${maxConcurrency}`;
  const ratio = `${running}/${maxConcurrency}`;
  const text = visibleWidth(full) <= width
    ? full
    : visibleWidth(compact) <= width
      ? compact
      : ratio;
  const style = options.style ?? ((value: string) => value);
  return truncateToWidth(style(text, "running", "aggregate"), width, "");
}

function validMaxConcurrency(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 1 ? value as number : undefined;
}

function normalizeWidth(width: number): number {
  if (!Number.isFinite(width)) return DEFAULT_PARALLEL_PROGRESS_WIDTH;
  // A zero-column render can happen while a host widget is being mounted. A
  // one-column degradation keeps the row non-empty instead of creating the
  // blank spacer that motivated the string-row path.
  return Math.max(1, Math.floor(width));
}

function compareScheduleOrder(left: ProgressLane, right: ProgressLane): number {
  return normalizedOrderValue(left.streamIndex) - normalizedOrderValue(right.streamIndex)
    || normalizedOrderValue(left.queueIndex) - normalizedOrderValue(right.queueIndex)
    || safeText(left.laneId, "stream").localeCompare(safeText(right.laneId, "stream"));
}

function normalizedOrderValue(value: number): number {
  return Number.isFinite(value) ? Math.floor(value) : Number.MAX_SAFE_INTEGER;
}

function boundedProgress(progress: ProgressLane["progress"]): { position: number; total: number } {
  const total = Number.isSafeInteger(progress.total) && progress.total >= 0 ? progress.total : 0;
  const rawPosition = Number.isFinite(progress.position) ? Math.floor(progress.position) : 0;
  return { position: Math.min(total, Math.max(0, rawPosition)), total };
}

function progressBar(position: number, total: number, width: number): string {
  const filled = total === 0 ? 0 : Math.min(width, Math.max(0, Math.floor((position / total) * width)));
  return `[${"|".repeat(filled)}${" ".repeat(width - filled)}]`;
}

function stageLabel(lane: ProgressLane): string | undefined {
  // An accepted lane may retain its terminal checkpoint for diagnostics, but
  // showing that old stage beside `Completed` would imply it is still active.
  if (lane.status !== "running" && lane.status !== "failed" && lane.status !== "interrupted") return undefined;
  const value = lane.activeStage?.label;
  if (typeof value !== "string") return undefined;
  const cleaned = value
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || undefined;
}

function statusLabel(status: ProgressLane["status"]): string {
  switch (status) {
    case "queued": return "Queued";
    case "running": return "Running";
    case "accepted": return "Completed";
    case "failed": return "Failed";
    case "interrupted": return "Interrupted";
    default: return "Queued";
  }
}

function safeName(name: string, laneId: string): string {
  // Names are data, not terminal markup. Remove control bytes (including ESC)
  // and collapse whitespace so one lane can never inject extra widget lines.
  const cleaned = safeText(name, laneId)
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || "stream";
}

function safeText(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function compactFallback(lane: ProgressLane): string {
  // This is only reachable for a malformed/zero-width host render. It is
  // intentionally plain text so Text and string-row hosts always receive a
  // meaningful row rather than an empty line.
  return statusLabel(lane.status).slice(0, 1);
}
