import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { MateriaCastState } from "./types.js";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { loadConfig, resolveArtifactRoot, saveActiveLoadout } from "./config.js";
import { renderGrid, resolvePipeline } from "./pipeline.js";
import { renderLoadoutList } from "./loadouts.js";
import { ActiveCastConflictError, CastCatalogUseCases, CastExecutionUseCases, LoadoutUseCases, configuredConfigPath, type ArtifactCatalog, type CastRuntime, type CastStateRepository, type ConfigRepository, type PipelinePresenter } from "./application/index.js";
import { publishActiveLoadoutChange } from "./activeLoadoutEvents.js";
import { registerMateriaRenderer } from "./renderer.js";
import { activeMateriaSystemPrompt, buildIsolatedMateriaContext, clearCastState, continueNativeCast, currentMateria, handleAgentEnd, listLatestCastStates, listResumableCastStates, listRevivableCastStates, loadActiveCastState, materiaStatusLabel, prepareMultiTurnRefinementTurn, resumeNativeCast, reviveNativeCast, startNativeCast } from "./native.js";
import { closeMateriaWebUiForSession, launchMateriaWebUi } from "./webui/launcher.js";
import { clearMateriaAuxiliaryWidgets, clearWidgetTicker, renderMateriaCastStatusWidget, updateWidget } from "./ui.js";

export default function piMateria(pi: ExtensionAPI) {
  registerMateriaRenderer(pi);
  let activeContext: ExtensionContext | undefined;
  const configRepository: ConfigRepository = { load: loadConfig, saveActiveLoadout, resolveArtifactRoot };
  const pipelinePresenter: PipelinePresenter = { resolve: resolvePipeline, renderGrid, renderLoadoutList };
  const castStates: CastStateRepository<ExtensionContext> = {
    loadActive: loadActiveCastState,
    listLatest: listLatestCastStates,
    listResumable: listResumableCastStates,
    listRevivable: listRevivableCastStates,
  };
  const artifacts: ArtifactCatalog = { renderCastList };
  const castRuntime: CastRuntime<ExtensionContext, ExtensionAPI, unknown> = {
    buildIsolatedContext: buildIsolatedMateriaContext,
    activeSystemPrompt: (state, materia) => activeMateriaSystemPrompt(state, materia as Parameters<typeof activeMateriaSystemPrompt>[1]),
    currentMateria,
    prepareMultiTurnRefinementTurn,
    handleAgentEnd: (api, event, ctx) => handleAgentEnd(api, event as Parameters<typeof handleAgentEnd>[1], ctx),
    start: startNativeCast,
    continue: continueNativeCast,
    resume: async (api, ctx, castId) => { await resumeNativeCast(api, ctx, castId); },
    revive: async (api, ctx, castId) => { await reviveNativeCast(api, ctx, castId); },
    clear: clearCastState,
    statusLabel: materiaStatusLabel,
  };
  const loadoutUseCases = new LoadoutUseCases({ configs: configRepository, pipeline: pipelinePresenter });
  const castCatalogUseCases = new CastCatalogUseCases({ configs: configRepository, states: castStates, artifacts });
  const castExecutionUseCases = new CastExecutionUseCases({ states: castStates, runtime: castRuntime, loadouts: loadoutUseCases });

  pi.registerFlag("materia-config", {
    description: "Path to a pi-materia loadout/config JSON file",
    type: "string",
  });

  pi.on("context", (event, ctx) => {
    activeContext = ctx;
    const messages = castExecutionUseCases.buildIsolatedContext(event.messages, ctx);
    if (!messages) return;
    return { messages: messages as typeof event.messages };
  });

  pi.on("before_agent_start", async (event, ctx) => {
    activeContext = ctx;
    const systemPrompt = await castExecutionUseCases.prepareAgentStart({ pi, session: ctx, systemPrompt: event.systemPrompt });
    if (!systemPrompt) return;
    return { systemPrompt };
  });

  pi.on("agent_end", async (event, ctx) => {
    activeContext = ctx;
    await castExecutionUseCases.handleAgentEnd(pi, event, ctx);
  });

  pi.on("session_start", (_event, ctx) => {
    activeContext = ctx;
    const state = loadActiveCastState(ctx);
    if (!state?.active) return;
    ctx.ui.setStatus("materia", materiaStatusLabel(state));
    ctx.ui.notify(`pi-materia cast ${state.castId} restored in ${state.phase}. Use /materia status for details.`, "info");
  });

  pi.on("session_shutdown", (_event, ctx) => {
    clearWidgetTicker(ctx);
    closeMateriaWebUiForSession(ctx);
  });

  pi.registerCommand("materia", {
    description: "Run pi-materia commands: cast, recast, revive, casts, grid, loadout, ui, status, continue, abort.",
    getArgumentCompletions: (prefix) => getMateriaArgumentCompletions(prefix, activeContext),
    handler: async (args, ctx) => {
      activeContext = ctx;
      const [subcommand, ...rest] = args.trim().split(/\s+/).filter(Boolean);

      if (subcommand === "ui") {
        try {
          const result = await launchMateriaWebUi(ctx, getConfiguredConfigPath(pi), pi);
          const lines = [`WebUI ${result.reused ? "ready" : "started"}: ${truncateLine(result.url, 110)}`];
          clearMateriaAuxiliaryWidgets(ctx);
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
          const { loaded, lines } = await loadoutUseCases.prepareGrid(ctx.cwd, getConfiguredConfigPath(pi));
          clearMateriaAuxiliaryWidgets(ctx);
          ctx.ui.notify(`pi-materia grid loaded from ${loaded.source}`, "info");
          pi.sendMessage({ customType: "pi-materia", content: lines.join("\n"), display: true, details: { prefix: "grid", materiaName: "orchestrator", eventType: "grid" } });
          pi.appendEntry("pi-materia-grid", { source: loaded.source, lines });
        } catch (error) {
          ctx.ui.notify(`pi-materia grid failed: ${error instanceof Error ? error.message : String(error)}`, "error");
        }
        return;
      }

      if (subcommand === "loadout") {
        const requestedLoadout = rest.join(" ").trim();
        try {
          const configuredPath = getConfiguredConfigPath(pi);
          if (requestedLoadout) {
            const { loaded, writtenPath: written } = await loadoutUseCases.selectActiveLoadout({ cwd: ctx.cwd, requestedLoadout, configuredPath, activeCast: castStates.loadActive(ctx) });
            clearMateriaAuxiliaryWidgets(ctx);
            publishActiveLoadoutChange(pi, ctx, {
              source: "command",
              loaded,
              writtenPath: written,
              notifyMessage: `pi-materia active loadout set to ${loaded.config.activeLoadout ?? requestedLoadout} (${written})`,
            });
          } else {
            const { lines } = await loadoutUseCases.listLoadouts(ctx.cwd, configuredPath);
            clearMateriaAuxiliaryWidgets(ctx);
            pi.sendMessage({ customType: "pi-materia", content: lines.join("\n"), display: true, details: { prefix: "loadout", materiaName: "orchestrator", eventType: "loadout" } });
          }
        } catch (error) {
          if (error instanceof ActiveCastConflictError) {
            ctx.ui.notify(error.message, "error");
            pi.sendMessage({ customType: "pi-materia", content: error.message, display: true, details: { prefix: "loadout", materiaName: "orchestrator", eventType: "loadout", source: "command", error: error.code, castId: error.castId } });
          } else {
            ctx.ui.notify(`pi-materia loadout failed: ${error instanceof Error ? error.message : String(error)}`, "error");
          }
        }
        return;
      }


      if (subcommand === "casts") {
        try {
          const { lines } = await castCatalogUseCases.listCasts({ cwd: ctx.cwd, session: ctx, configuredPath: getConfiguredConfigPath(pi) });
          clearMateriaAuxiliaryWidgets(ctx);
          pi.sendMessage({ customType: "pi-materia", content: lines.join("\n"), display: true, details: { prefix: "casts", materiaName: "orchestrator", eventType: "casts" } });
        } catch (error) {
          ctx.ui.notify(`pi-materia casts failed: ${error instanceof Error ? error.message : String(error)}`, "error");
        }
        return;
      }

      if (subcommand === "status") {
        const state = castExecutionUseCases.status(ctx);
        if (!state) {
          ctx.ui.notify("No pi-materia cast state in this session.", "info");
          return;
        }
        const lines = renderMateriaCastStatusWidget(state);
        clearMateriaAuxiliaryWidgets(ctx);
        ctx.ui.setWidget("materia", lines, { placement: "belowEditor" });
        pi.sendMessage({ customType: "pi-materia", content: lines.join("\n"), display: true, details: { prefix: "status", materiaName: "orchestrator", eventType: "status" } });
        return;
      }

      if (subcommand === "abort") {
        const state = castExecutionUseCases.abortActive(pi, ctx);
        if (!state) {
          ctx.ui.notify("No active pi-materia cast to abort.", "info");
          return;
        }
        updateWidget(ctx, state.runState);
        ctx.ui.setStatus("materia", undefined);
        ctx.ui.notify(`pi-materia cast ${state.castId} aborted.`, "warning");
        return;
      }

      if (subcommand === "continue") {
        try {
          await castExecutionUseCases.continueCast(pi, ctx);
        } catch (error) {
          ctx.ui.notify(`pi-materia continue failed: ${error instanceof Error ? error.message : String(error)}`, "error");
        }
        return;
      }

      if (subcommand === "recast") {
        try {
          const requestedCastId = rest.join(" ").trim();
          const castId = await castExecutionUseCases.resumeLatestOrRequested(pi, ctx, requestedCastId);
          if (!castId) {
            ctx.ui.notify("No failed or aborted pi-materia casts are available to recast.", "info");
            return;
          }
        } catch (error) {
          ctx.ui.notify(`pi-materia recast failed: ${error instanceof Error ? error.message : String(error)}`, "error");
        }
        return;
      }

      if (subcommand === "revive") {
        try {
          const requestedCastId = rest.join(" ").trim();
          const castId = await castExecutionUseCases.reviveLatestOrRequested(pi, ctx, requestedCastId);
          if (!castId) {
            ctx.ui.notify("No failed pi-materia casts exhausted by same-node recovery are available to revive. Use /materia recast [cast-id] for general failed or aborted casts.", "info");
            return;
          }
        } catch (error) {
          ctx.ui.notify(`pi-materia revive failed: ${error instanceof Error ? error.message : String(error)}`, "error");
        }
        return;
      }

      if (subcommand !== "cast") {
        ctx.ui.notify("Usage: /materia cast <task>, /materia recast [cast-id], /materia revive [cast-id] (only after same-node recovery attempts are exhausted; adds the original attempt allowance then recasts), /materia casts, /materia grid, /materia loadout [name], /materia ui, /materia status, /materia continue, or /materia abort", "error");
        return;
      }

      const request = rest.join(" ").trim();
      if (!request) {
        ctx.ui.notify("Usage: /materia cast <high-level software task>", "error");
        return;
      }

      try {
        const { loaded, pipeline } = await castExecutionUseCases.startCast({ pi, session: ctx, cwd: ctx.cwd, request, configuredPath: getConfiguredConfigPath(pi) });
        ctx.ui.notify(`pi-materia config: ${loaded.source}`, "info");
        ctx.ui.notify(`pi-materia grid entry: ${pipeline.entry.id}`, "info");
      } catch (error) {
        if (error instanceof ActiveCastConflictError) {
          ctx.ui.notify(`A pi-materia cast is already active (${error.castId}). Use /materia status or /materia abort.`, "error");
          return;
        }
        ctx.ui.setStatus("materia", "failed");
        ctx.ui.notify(`pi-materia cast failed to start: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });
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
    const subcommands = materiaSubcommands();
    return subcommands.map((value) => ({ value, label: value }));
  }

  if (tokens.length === 1 && !endsWithWhitespace) {
    const subcommands = materiaSubcommands();
    const matching = subcommands.filter((value) => value.startsWith(tokens[0]));
    return matching.length ? matching.map((value) => ({ value, label: value })) : null;
  }

  if ((tokens[0] !== "recast" && tokens[0] !== "revive") || !ctx) return null;
  const command = tokens[0];
  const castIdPrefix = endsWithWhitespace ? "" : (tokens[1] ?? "");
  const states = command === "revive" ? listRevivableCastStates(ctx) : listResumableCastStates(ctx);
  const completions = states
    .filter((state) => state.castId.startsWith(castIdPrefix))
    .map((state) => ({
      value: `${command} ${state.castId}`,
      label: `${state.castId}  ${command === "revive" ? "revivable" : recastStatusLabel(state)}  node:${state.currentNode ?? "-"}`,
      description: truncateLine(state.request ?? state.failedReason ?? state.runState?.lastMessage ?? "", 72),
    }));
  return completions.length ? completions : null;
}

function materiaSubcommands(): string[] {
  return ["cast", "recast", "revive", "casts", "grid", "loadout", "ui", "status", "continue", "abort"];
}

function recastStatusLabel(state: MateriaCastState): string {
  return state.failedReason?.toLowerCase().includes("abort") ? "aborted" : "failed";
}

function truncateLine(value: string, max: number): string {
  const singleLine = value.replace(/\s+/g, " ").trim();
  return singleLine.length > max ? `${singleLine.slice(0, Math.max(0, max - 1))}…` : singleLine;
}

function getConfiguredConfigPath(pi: ExtensionAPI): string | undefined {
  return configuredConfigPath(pi, { get: (name) => process.env[name] });
}
