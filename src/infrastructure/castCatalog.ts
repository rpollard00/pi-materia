import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { currentCastSocketId, currentCastSocketState } from "../runtime/castStateAccessors.js";
import type { MateriaCastState } from "../types.js";

export async function renderCastList(artifactRoot: string, sessionStates: MateriaCastState[] = []): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(artifactRoot);
  } catch {
    return [`Materia Casts`, `artifact root: ${artifactRoot}`, "", "No casts found."];
  }

  const stateById = new Map(sessionStates.map((state) => [state.castId, state]));
  const casts = await Promise.all(names.map(async (name) => {
    const dir = path.join(artifactRoot, name);
    try {
      if (!(await stat(dir)).isDirectory()) return undefined;
      return await readCastSummary(name, dir, stateById.get(name));
    } catch {
      return undefined;
    }
  }));

  const valid = casts.filter((cast): cast is CastSummary => Boolean(cast)).sort(compareCastsNewestFirst);
  return [
    "Materia Casts",
    `artifact root: ${artifactRoot}`,
    valid.length ? "newest first; failed/aborted recast targets are marked with ↻" : "",
    "",
    ...(valid.length ? valid.flatMap(renderCastSummaryLines) : ["No casts found."]),
  ];
}

interface CastSummary {
  id: string;
  dir: string;
  modified: number;
  sortTime: number;
  status: string;
  recastTarget: boolean;
  request?: string;
  currentSocketId?: string;
  currentMateria?: string;
  currentItemKey?: string;
  currentItemLabel?: string;
  visit?: number;
  error?: string;
}

async function readCastSummary(id: string, dir: string, state?: MateriaCastState): Promise<CastSummary> {
  const modified = (await stat(dir)).mtimeMs;
  const manifest = await readJsonFile<{ request?: string }>(path.join(dir, "manifest.json"));
  const events = await readEvents(path.join(dir, "events.jsonl"));
  const start = events.find((event) => event.type === "cast_start");
  const end = [...events].reverse().find((event) => event.type === "cast_end");
  const latestProgress = latestProgressEvent(events);
  const endData = objectData(end);
  const ok = endData?.ok;
  const eventError = typeof endData?.error === "string" ? endData.error : undefined;
  const request = state?.request ?? manifest?.request ?? stringField(objectData(start), "request");
  const status = state ? stateStatus(state) : ok === true ? "complete" : ok === false ? failureStatus(eventError) : "active/unknown";
  return {
    id,
    dir,
    modified,
    sortTime: castSortTime(id, modified),
    status,
    recastTarget: state ? isRecastTargetState(state) : status === "failed" || status === "aborted",
    request,
    currentSocketId: (state ? currentCastSocketId(state) : undefined) ?? stringField(latestProgress, "socket") ?? stringField(endData, "socket"),
    currentMateria: state?.currentMateria ?? stringField(latestProgress, "materia"),
    currentItemKey: state?.currentItemKey ?? stringField(latestProgress, "itemKey"),
    currentItemLabel: state?.currentItemLabel ?? stringField(latestProgress, "itemLabel"),
    visit: typeof latestProgress?.visit === "number" ? latestProgress.visit : undefined,
    error: state?.failedReason ?? eventError,
  };
}

function renderCastSummaryLines(cast: CastSummary): string[] {
  const marker = cast.recastTarget ? "↻ RECAST TARGET" : " ";
  const lines = [
    `${marker}  ${cast.status}  ${cast.id}`,
    `  request: ${truncateLine(cast.request ?? "-", 96)}`,
  ];
  const progress = castProgressLine(cast);
  if (progress) lines.push(`  progress: ${progress}`);
  if (cast.recastTarget) lines.push(`  recast: /materia recast ${cast.id}`);
  if (cast.error) lines.push(`  error: ${truncateLine(cast.error, 120)}`);
  lines.push(`  updated: ${new Date(cast.modified).toLocaleString()}`);
  lines.push(`  path: ${cast.dir}`);
  return lines;
}

function castProgressLine(cast: CastSummary): string | undefined {
  const parts = [
    cast.currentSocketId ? `socket ${cast.currentSocketId}` : undefined,
    cast.currentMateria ? `materia ${cast.currentMateria}` : undefined,
    cast.currentItemKey ? `item ${cast.currentItemKey}${cast.currentItemLabel ? ` - ${cast.currentItemLabel}` : ""}` : cast.currentItemLabel ? `item ${cast.currentItemLabel}` : undefined,
    typeof cast.visit === "number" ? `visit ${cast.visit}` : undefined,
  ].filter((part): part is string => Boolean(part));
  return parts.length ? truncateLine(parts.join("; "), 120) : undefined;
}

function compareCastsNewestFirst(a: CastSummary, b: CastSummary): number {
  return b.sortTime - a.sortTime || b.modified - a.modified || b.id.localeCompare(a.id);
}

function castSortTime(id: string, fallback: number): number {
  const parsed = Date.parse(id.replace(/-(\d{3})Z$/, ".$1Z"));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function stateStatus(state: MateriaCastState): string {
  const socketState = currentCastSocketState(state);
  if (state.active) return "running";
  if (state.phase === "complete" || socketState === "complete") return "complete";
  if (state.phase === "failed" || socketState === "failed") return failureStatus(state.failedReason);
  return socketState ?? state.phase ?? "active/unknown";
}

function isRecastTargetState(state: MateriaCastState): boolean {
  const socketState = currentCastSocketState(state);
  return !state.active && state.phase !== "complete" && socketState !== "complete" && (state.phase === "failed" || socketState === "failed");
}

function failureStatus(reason?: string): string {
  return reason?.toLowerCase().includes("abort") ? "aborted" : "failed";
}

function latestProgressEvent(events: CastEvent[]): Record<string, unknown> | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type !== "socket_start" && events[i].type !== "socket_complete" && events[i].type !== "materia_model_settings") continue;
    const data = objectData(events[i]);
    if (data) return data;
  }
  return undefined;
}

function objectData(event: CastEvent | undefined): Record<string, unknown> | undefined {
  return event?.data && typeof event.data === "object" && !Array.isArray(event.data) ? event.data as Record<string, unknown> : undefined;
}

function stringField(value: Record<string, unknown> | undefined, key: string): string | undefined {
  return typeof value?.[key] === "string" ? value[key] : undefined;
}

async function readJsonFile<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

interface CastEvent {
  type?: string;
  data?: unknown;
}

async function readEvents(file: string): Promise<CastEvent[]> {
  try {
    return (await readFile(file, "utf8"))
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as CastEvent);
  } catch {
    return [];
  }
}

function truncateLine(value: string, max: number): string {
  const singleLine = value.replace(/\s+/g, " ").trim();
  return singleLine.length > max ? `${singleLine.slice(0, Math.max(0, max - 1))}…` : singleLine;
}
