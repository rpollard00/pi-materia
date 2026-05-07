import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { MateriaCastState, PiMateriaConfig } from "./types.js";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { loadConfig, resolveArtifactRoot, saveActiveLoadout } from "./config.js";
import { renderGrid, resolvePipeline } from "./pipeline.js";
import { registerMateriaRenderer } from "./renderer.js";
import { activeMateriaSystemPrompt, buildIsolatedMateriaContext, clearCastState, continueNativeCast, currentMateria, handleAgentEnd, listLatestCastStates, listResumableCastStates, loadActiveCastState, prepareMultiTurnRefinementTurn, resumeNativeCast, startNativeCast } from "./native.js";
import { closeMateriaWebUiForSession, launchMateriaWebUi } from "./webui/launcher.js";

export default function piMateria(pi: ExtensionAPI) {
  registerMateriaRenderer(pi);
  let activeContext: ExtensionContext | undefined;

  pi.registerFlag("materia-config", {
    description: "Path to a pi-materia loadout/config JSON file",
    type: "string",
  });

  pi.on("context", (event, ctx) => {
    activeContext = ctx;
    const state = loadActiveCastState(ctx);
    if (!state?.active) return;
    return {
      messages: buildIsolatedMateriaContext(event.messages, state) as typeof event.messages,
    };
  });

  pi.on("before_agent_start", async (event, ctx) => {
    activeContext = ctx;
    const state = loadActiveCastState(ctx);
    if (!state?.active) return;
    if (state.nodeState === "awaiting_user_refinement") await prepareMultiTurnRefinementTurn(pi, ctx, state);
    if (!state.awaitingResponse) return;
    const materia = currentMateria(state);
    if (!materia) return;
    return {
      systemPrompt: `${event.systemPrompt}\n\nMateria active materia (${state.currentNode ?? state.phase}):\n${activeMateriaSystemPrompt(state, materia)}`,
    };
  });

  pi.on("agent_end", async (event, ctx) => {
    activeContext = ctx;
    await handleAgentEnd(pi, event, ctx);
  });

  pi.on("session_start", (_event, ctx) => {
    activeContext = ctx;
    const state = loadActiveCastState(ctx);
    if (!state?.active) return;
    ctx.ui.setStatus("materia", `${state.phase}${state.currentNode ? `:${state.currentNode}` : ""}`);
    ctx.ui.notify(`pi-materia cast ${state.castId} restored in ${state.phase}. Use /materia status for details.`, "info");
  });

  pi.on("session_shutdown", (_event, ctx) => {
    closeMateriaWebUiForSession(ctx);
  });

  pi.registerCommand("materia", {
    description: "Run pi-materia commands: cast, recast, casts, grid, loadout, ui, status, continue, abort.",
    getArgumentCompletions: (prefix) => getMateriaArgumentCompletions(prefix, activeContext),
    handler: async (args, ctx) => {
      activeContext = ctx;
      const [subcommand, ...rest] = args.trim().split(/\s+/).filter(Boolean);

      if (subcommand === "ui") {
        try {
          const result = await launchMateriaWebUi(ctx, getConfiguredConfigPath(pi), pi);
          const lines = [
            "Materia WebUI",
            result.reused ? "reused existing session-scoped server" : "started session-scoped server in background",
            `url: ${result.url}`,
            `browser auto-open: ${result.autoOpenBrowser ? "enabled" : "disabled"}`,
            "scope: this Pi session only",
          ];
          ctx.ui.setWidget("materia-webui", lines, { placement: "belowEditor" });
          ctx.ui.notify(`Materia WebUI ${result.reused ? "ready" : "started"}: ${result.url}`, "info");
          pi.sendMessage({ customType: "pi-materia", content: lines.join("\n"), display: true, details: { prefix: "ui", materiaName: "orchestrator", eventType: "ui", url: result.url, sessionKey: result.sessionKey } });
          pi.appendEntry("pi-materia-webui", { url: result.url, sessionKey: result.sessionKey, reused: result.reused, startedAt: Date.now() });
        } catch (error) {
          ctx.ui.notify(`pi-materia ui failed: ${error instanceof Error ? error.message : String(error)}`, "error");
        }
        return;
      }

      await ctx.waitForIdle();

      if (subcommand === "grid") {
        try {
          const loaded = await loadConfig(ctx.cwd, getConfiguredConfigPath(pi));
          const pipeline = resolvePipeline(loaded.config);
          const lines = renderGrid(loaded.config, pipeline, loaded.source, ctx.cwd);
          ctx.ui.setWidget("materia-grid", lines, { placement: "belowEditor" });
          ctx.ui.notify(`pi-materia grid loaded from ${loaded.source}`, "info");
          pi.appendEntry("pi-materia-grid", { source: loaded.source, lines });
        } catch (error) {
          ctx.ui.notify(`pi-materia grid failed: ${error instanceof Error ? error.message : String(error)}`, "error");
        }
        return;
      }

      if (subcommand === "loadout") {
        const requestedLoadout = rest.join(" ").trim();
        try {
          if (requestedLoadout) {
            const written = await saveActiveLoadout(ctx.cwd, requestedLoadout, getConfiguredConfigPath(pi));
            ctx.ui.notify(`pi-materia active loadout set to ${requestedLoadout} (${written})`, "info");
          }
          const loaded = await loadConfig(ctx.cwd, getConfiguredConfigPath(pi));
          const lines = renderLoadoutList(loaded.config, loaded.source);
          ctx.ui.setWidget("materia-loadouts", lines, { placement: "belowEditor" });
          pi.sendMessage({ customType: "pi-materia", content: lines.join("\n"), display: true, details: { prefix: "loadout", materiaName: "orchestrator", eventType: "loadout" } });
        } catch (error) {
          ctx.ui.notify(`pi-materia loadout failed: ${error instanceof Error ? error.message : String(error)}`, "error");
        }
        return;
      }


      if (subcommand === "casts") {
        try {
          const loaded = await loadConfig(ctx.cwd, getConfiguredConfigPath(pi));
          const artifactRoot = resolveArtifactRoot(ctx.cwd, loaded.config.artifactDir);
          const lines = await renderCastList(artifactRoot, listLatestCastStates(ctx));
          ctx.ui.setWidget("materia-casts", lines, { placement: "belowEditor" });
          pi.sendMessage({ customType: "pi-materia", content: lines.join("\n"), display: true, details: { prefix: "casts", materiaName: "orchestrator", eventType: "casts" } });
        } catch (error) {
          ctx.ui.notify(`pi-materia casts failed: ${error instanceof Error ? error.message : String(error)}`, "error");
        }
        return;
      }

      if (subcommand === "status") {
        const state = loadActiveCastState(ctx);
        if (!state) {
          ctx.ui.notify("No pi-materia cast state in this session.", "info");
          return;
        }
        const nodeState = state.nodeState ?? (state.awaitingResponse ? "awaiting_agent_response" : state.active ? "idle" : state.phase === "complete" ? "complete" : state.phase === "failed" ? "failed" : "idle");
        const lines = [
          `Materia Cast ${state.castId}`,
          `active: ${state.active}`,
          `phase: ${state.phase}`,
          `node state: ${nodeState}`,
          nodeState === "awaiting_user_refinement" ? "waiting: user refinement; run /materia continue to finalize this multi-turn node" : undefined,
          `awaiting response: ${state.awaitingResponse}`,
          `node: ${state.currentNode ?? "-"}`,
          `materia: ${state.currentMateria ?? "-"}`,
          `item: ${state.currentItemKey ? `${state.currentItemKey} - ${state.currentItemLabel ?? ""}` : "-"}`,
          `visits: ${JSON.stringify(state.visits)}`,
          `artifacts: ${state.runDir}`,
          state.failedReason ? `failed: ${state.failedReason}` : undefined,
        ].filter((line): line is string => Boolean(line));
        ctx.ui.setWidget("materia-status", lines, { placement: "belowEditor" });
        pi.sendMessage({ customType: "pi-materia", content: lines.join("\n"), display: true, details: { prefix: "status", materiaName: "orchestrator", eventType: "status" } });
        return;
      }

      if (subcommand === "abort") {
        const state = loadActiveCastState(ctx);
        if (!state?.active) {
          ctx.ui.notify("No active pi-materia cast to abort.", "info");
          return;
        }
        clearCastState(pi, state, "aborted by user");
        ctx.ui.setStatus("materia", undefined);
        ctx.ui.notify(`pi-materia cast ${state.castId} aborted.`, "warning");
        return;
      }

      if (subcommand === "continue") {
        try {
          const state = loadActiveCastState(ctx);
          if (!state) throw new Error("No pi-materia cast state in this session.");
          await continueNativeCast(pi, ctx, state);
        } catch (error) {
          ctx.ui.notify(`pi-materia continue failed: ${error instanceof Error ? error.message : String(error)}`, "error");
        }
        return;
      }

      if (subcommand === "recast") {
        try {
          const requestedCastId = rest.join(" ").trim();
          const castId = requestedCastId || listResumableCastStates(ctx)[0]?.castId;
          if (!castId) {
            ctx.ui.notify("No failed or aborted pi-materia casts are available to recast.", "info");
            return;
          }
          await resumeNativeCast(pi, ctx, castId);
        } catch (error) {
          ctx.ui.notify(`pi-materia recast failed: ${error instanceof Error ? error.message : String(error)}`, "error");
        }
        return;
      }

      if (subcommand !== "cast") {
        ctx.ui.notify("Usage: /materia cast <task>, /materia recast [cast-id], /materia casts, /materia grid, /materia loadout [name], /materia ui, /materia status, /materia continue, or /materia abort", "error");
        return;
      }

      const request = rest.join(" ").trim();
      if (!request) {
        ctx.ui.notify("Usage: /materia cast <high-level software task>", "error");
        return;
      }

      const active = loadActiveCastState(ctx);
      if (active?.active) {
        ctx.ui.notify(`A pi-materia cast is already active (${active.castId}). Use /materia status or /materia abort.`, "error");
        return;
      }

      try {
        const loaded = await loadConfig(ctx.cwd, getConfiguredConfigPath(pi));
        const pipeline = resolvePipeline(loaded.config);
        ctx.ui.notify(`pi-materia config: ${loaded.source}`, "info");
        ctx.ui.notify(`pi-materia grid entry: ${pipeline.entry.id}`, "info");
        await startNativeCast(pi, ctx, loaded, pipeline, request);
      } catch (error) {
        ctx.ui.setStatus("materia", "failed");
        ctx.ui.notify(`pi-materia cast failed to start: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });
}

function renderLoadoutList(config: PiMateriaConfig, source: string): string[] {
  const loadoutNames = Object.keys(config.loadouts ?? {});
  if (loadoutNames.length === 0) {
    return ["Materia Loadouts", `source: ${source}`, "", "No loadouts configured. Define named loadouts and set activeLoadout."];
  }

  const active = config.activeLoadout;
  return [
    "Materia Loadouts",
    `source: ${source}`,
    `active: ${active ?? "-"}`,
    "",
    ...loadoutNames.map((name) => `- ${name}${name === active ? " (active)" : ""}`),
  ];
}

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
  currentNode?: string;
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
    currentNode: state?.currentNode ?? stringField(latestProgress, "node") ?? stringField(endData, "node"),
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
    cast.currentNode ? `node ${cast.currentNode}` : undefined,
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
  if (state.active) return "running";
  if (state.phase === "complete" || state.nodeState === "complete") return "complete";
  if (state.phase === "failed" || state.nodeState === "failed") return failureStatus(state.failedReason);
  return state.nodeState ?? state.phase ?? "active/unknown";
}

function isRecastTargetState(state: MateriaCastState): boolean {
  return !state.active && state.phase !== "complete" && state.nodeState !== "complete" && (state.phase === "failed" || state.nodeState === "failed");
}

function failureStatus(reason?: string): string {
  return reason?.toLowerCase().includes("abort") ? "aborted" : "failed";
}

function latestProgressEvent(events: CastEvent[]): Record<string, unknown> | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type !== "node_start" && events[i].type !== "node_complete" && events[i].type !== "materia_model_settings") continue;
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

function getMateriaArgumentCompletions(prefix: string, ctx: ExtensionContext | undefined): Array<{ value: string; label: string; description?: string }> | null {
  const trimmedStart = prefix.trimStart();
  const tokens = trimmedStart.split(/\s+/).filter(Boolean);
  const endsWithWhitespace = /\s$/.test(prefix);

  if (tokens.length === 0 && !endsWithWhitespace) {
    const subcommands = ["cast", "recast", "casts", "grid", "loadout", "ui", "status", "continue", "abort"];
    return subcommands.map((value) => ({ value, label: value }));
  }

  if (tokens.length === 1 && !endsWithWhitespace) {
    const subcommands = ["cast", "recast", "casts", "grid", "loadout", "ui", "status", "continue", "abort"];
    const matching = subcommands.filter((value) => value.startsWith(tokens[0]));
    return matching.length ? matching.map((value) => ({ value, label: value })) : null;
  }

  if (tokens[0] !== "recast" || !ctx) return null;
  const castIdPrefix = endsWithWhitespace ? "" : (tokens[1] ?? "");
  const completions = listResumableCastStates(ctx)
    .filter((state) => state.castId.startsWith(castIdPrefix))
    .map((state) => ({
      value: `recast ${state.castId}`,
      label: `${state.castId}  ${recastStatusLabel(state)}  node:${state.currentNode ?? "-"}`,
      description: truncateLine(state.request ?? state.failedReason ?? state.runState?.lastMessage ?? "", 72),
    }));
  return completions.length ? completions : null;
}

function recastStatusLabel(state: MateriaCastState): string {
  return state.failedReason?.toLowerCase().includes("abort") ? "aborted" : "failed";
}

function truncateLine(value: string, max: number): string {
  const singleLine = value.replace(/\s+/g, " ").trim();
  return singleLine.length > max ? `${singleLine.slice(0, Math.max(0, max - 1))}…` : singleLine;
}

function getConfiguredConfigPath(pi: ExtensionAPI): string | undefined {
  const flagValue = pi.getFlag("materia-config");
  if (typeof flagValue === "string" && flagValue.trim()) return flagValue.trim();
  if (process.env.MATERIA_CONFIG?.trim()) return process.env.MATERIA_CONFIG.trim();
  return undefined;
}
