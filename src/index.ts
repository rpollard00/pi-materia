import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { loadConfig, resolveArtifactRoot } from "./config.js";
import { renderGrid, resolvePipeline } from "./pipeline.js";
import { registerMateriaRenderer } from "./renderer.js";
import { buildIsolatedMateriaContext, clearCastState, continueNativeCast, currentRole, handleAgentEnd, loadActiveCastState, startNativeCast } from "./native.js";

export default function piMateria(pi: ExtensionAPI) {
  registerMateriaRenderer(pi);

  pi.registerFlag("materia-config", {
    description: "Path to a pi-materia loadout/config JSON file",
    type: "string",
  });

  pi.on("context", (event, ctx) => {
    const state = loadActiveCastState(ctx);
    if (!state?.active || !state.awaitingResponse) return;
    return {
      messages: buildIsolatedMateriaContext(event.messages, state) as typeof event.messages,
    };
  });

  pi.on("before_agent_start", (event, ctx) => {
    const state = loadActiveCastState(ctx);
    if (!state?.active || !state.awaitingResponse) return;
    const role = currentRole(state);
    if (!role) return;
    return {
      systemPrompt: `${event.systemPrompt}\n\nMateria active role (${state.currentNode ?? state.phase}):\n${role.systemPrompt}`,
    };
  });

  pi.on("agent_end", async (event, ctx) => {
    await handleAgentEnd(pi, event, ctx);
  });

  pi.on("session_start", (_event, ctx) => {
    const state = loadActiveCastState(ctx);
    if (!state?.active) return;
    ctx.ui.setStatus("materia", `${state.phase}${state.currentNode ? `:${state.currentNode}` : ""}`);
    ctx.ui.notify(`pi-materia cast ${state.castId} restored in ${state.phase}. Use /materia status or /materia continue.`, "info");
  });

  pi.registerCommand("materia", {
    description: "Run pi-materia commands: cast, casts, grid, status, continue, abort.",
    handler: async (args, ctx) => {
      await ctx.waitForIdle();
      const [subcommand, ...rest] = args.trim().split(/\s+/).filter(Boolean);

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

      if (subcommand === "casts") {
        try {
          const loaded = await loadConfig(ctx.cwd, getConfiguredConfigPath(pi));
          const artifactRoot = resolveArtifactRoot(ctx.cwd, loaded.config.artifactDir);
          const lines = await renderCastList(artifactRoot);
          ctx.ui.setWidget("materia-casts", lines, { placement: "belowEditor" });
          pi.sendMessage({ customType: "pi-materia", content: lines.join("\n"), display: true, details: { prefix: "casts", roleName: "orchestrator", eventType: "casts" } });
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
          nodeState === "awaiting_user_refinement" ? "waiting: user refinement or /materia continue to finalize this multi-turn node" : undefined,
          `awaiting response: ${state.awaitingResponse}`,
          `node: ${state.currentNode ?? "-"}`,
          `role: ${state.currentRole ?? "-"}`,
          `item: ${state.currentItemKey ? `${state.currentItemKey} - ${state.currentItemLabel ?? ""}` : "-"}`,
          `visits: ${JSON.stringify(state.visits)}`,
          `artifacts: ${state.runDir}`,
          state.failedReason ? `failed: ${state.failedReason}` : undefined,
        ].filter((line): line is string => Boolean(line));
        ctx.ui.setWidget("materia-status", lines, { placement: "belowEditor" });
        pi.sendMessage({ customType: "pi-materia", content: lines.join("\n"), display: true, details: { prefix: "status", roleName: "orchestrator", eventType: "status" } });
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

      if (subcommand !== "cast") {
        ctx.ui.notify("Usage: /materia cast <task>, /materia casts, /materia grid, /materia status, /materia continue, or /materia abort", "error");
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

async function renderCastList(artifactRoot: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(artifactRoot);
  } catch {
    return [`Materia Casts`, `artifact root: ${artifactRoot}`, "", "No casts found."];
  }

  const casts = await Promise.all(names.map(async (name) => {
    const dir = path.join(artifactRoot, name);
    try {
      if (!(await stat(dir)).isDirectory()) return undefined;
      return await readCastSummary(name, dir);
    } catch {
      return undefined;
    }
  }));

  const valid = casts.filter((cast): cast is CastSummary => Boolean(cast)).sort((a, b) => b.modified - a.modified);
  return [
    "Materia Casts",
    `artifact root: ${artifactRoot}`,
    "",
    ...(valid.length ? valid.flatMap((cast) => [
      `${cast.id}  ${cast.status}`,
      `  request: ${cast.request ?? "-"}`,
      `  updated: ${new Date(cast.modified).toLocaleString()}`,
      `  path: ${cast.dir}`,
    ]) : ["No casts found."]),
  ];
}

interface CastSummary {
  id: string;
  dir: string;
  modified: number;
  status: string;
  request?: string;
}

async function readCastSummary(id: string, dir: string): Promise<CastSummary> {
  const modified = (await stat(dir)).mtimeMs;
  const manifest = await readJsonFile<{ request?: string }>(path.join(dir, "manifest.json"));
  const events = await readEvents(path.join(dir, "events.jsonl"));
  const start = events.find((event) => event.type === "cast_start");
  const end = [...events].reverse().find((event) => event.type === "cast_end");
  const ok = end?.data && typeof end.data === "object" ? (end.data as { ok?: unknown }).ok : undefined;
  return {
    id,
    dir,
    modified,
    status: ok === true ? "complete" : ok === false ? "failed" : "active/unknown",
    request: manifest?.request ?? (start?.data as { request?: string } | undefined)?.request,
  };
}

async function readJsonFile<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

async function readEvents(file: string): Promise<Array<{ type?: string; data?: unknown }>> {
  try {
    return (await readFile(file, "utf8"))
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { type?: string; data?: unknown });
  } catch {
    return [];
  }
}

function getConfiguredConfigPath(pi: ExtensionAPI): string | undefined {
  const flagValue = pi.getFlag("materia-config");
  if (typeof flagValue === "string" && flagValue.trim()) return flagValue.trim();
  if (process.env.MATERIA_CONFIG?.trim()) return process.env.MATERIA_CONFIG.trim();
  return undefined;
}
