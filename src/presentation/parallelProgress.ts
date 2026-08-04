import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ParallelLaneMonitorSummary } from "../application/parallelMonitoring.js";

export type ParallelProgressPart = "bar" | "name" | "detail" | "status";

export interface ParallelProgressFormatOptions {
  /** Optional late-bound theming. The formatter remains ANSI-width aware. */
  style?: (
    text: string,
    status: ParallelLaneMonitorSummary["status"],
    part: ParallelProgressPart,
  ) => string;
  maxBarWidth?: number;
}

type ProgressLane = Pick<
  ParallelLaneMonitorSummary,
  "laneId" | "name" | "streamIndex" | "queueIndex" | "status" | "progress"
>;

const DEFAULT_MAX_BAR_WIDTH = 20;

/**
 * Render one bounded line per normalized stream without mutating the monitor DTO.
 * Schedule order is streamIndex first, with stable persisted fields as tie-breakers.
 */
export function formatParallelProgress(
  lanes: readonly ProgressLane[],
  width: number,
  options: ParallelProgressFormatOptions = {},
): string[] {
  const boundedWidth = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
  return [...lanes]
    .sort(compareScheduleOrder)
    .map((lane) => formatLane(lane, boundedWidth, options));
}

/** Mutable, non-focusable widget component; updates naturally support graph rewinds. */
export class ParallelProgressComponent implements Component {
  private lanes: readonly ProgressLane[];

  constructor(
    lanes: readonly ProgressLane[],
    private readonly options: ParallelProgressFormatOptions = {},
  ) {
    this.lanes = lanes;
  }

  setLanes(lanes: readonly ProgressLane[]): void {
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
  const maxBarWidth = Number.isFinite(options.maxBarWidth)
    ? Math.max(1, Math.floor(options.maxBarWidth ?? DEFAULT_MAX_BAR_WIDTH))
    : DEFAULT_MAX_BAR_WIDTH;

  // Reserve room for the name and all progress/state details before growing the
  // bar. This keeps terminal labels visible on moderately narrow terminals.
  const nonBarWidth = 1 + visibleWidth(detail) + 1 + visibleWidth(status) + 3;
  const desiredBarWidth = Math.min(maxBarWidth, Math.max(1, Math.floor(width / 4)));
  const barWidth = Math.max(1, Math.min(desiredBarWidth, width - nonBarWidth - 1));
  const bar = progressBar(position, total, barWidth);
  const fixedWidth = visibleWidth(bar) + 1 + 1 + visibleWidth(detail) + 1 + visibleWidth(status);
  const nameWidth = Math.max(1, width - fixedWidth);
  const boundedName = truncateToWidth(name, nameWidth, "…");
  const style = options.style ?? ((text: string) => text);

  const line = [
    style(bar, lane.status, "bar"),
    style(boundedName, lane.status, "name"),
    style(detail, lane.status, "detail"),
    style(status, lane.status, "status"),
  ].join(" ");
  return truncateToWidth(line, width, "");
}

function compareScheduleOrder(left: ProgressLane, right: ProgressLane): number {
  return left.streamIndex - right.streamIndex
    || left.queueIndex - right.queueIndex
    || left.laneId.localeCompare(right.laneId);
}

function boundedProgress(progress: ProgressLane["progress"]): { position: number; total: number } {
  const total = Number.isSafeInteger(progress.total) && progress.total >= 0 ? progress.total : 0;
  const rawPosition = Number.isFinite(progress.position) ? Math.floor(progress.position) : 0;
  return { position: Math.min(total, Math.max(0, rawPosition)), total };
}

function progressBar(position: number, total: number, width: number): string {
  const filled = total === 0 ? 0 : Math.floor((position / total) * width);
  return `[${"|".repeat(filled)}${" ".repeat(width - filled)}]`;
}

function statusLabel(status: ProgressLane["status"]): string {
  switch (status) {
    case "queued": return "Queued";
    case "running": return "Running";
    case "accepted": return "Completed";
    case "failed": return "Failed";
    case "interrupted": return "Interrupted";
  }
}

function safeName(name: string, laneId: string): string {
  // Names are data, not terminal markup. Remove control bytes (including ESC)
  // and collapse whitespace so one lane can never inject extra widget lines.
  const cleaned = (name.trim() || laneId)
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || "stream";
}
