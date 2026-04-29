import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { loadConfig } from "./config.js";
import { renderGrid, resolvePipeline } from "./pipeline.js";
import { registerMateriaRenderer } from "./renderer.js";
import { buildIsolatedMateriaContext, clearCastState, continueNativeCast, handleAgentEnd, loadActiveCastState, startNativeCast } from "./native.js";

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
    const role = state.phase === "planning"
      ? state.pipeline.planner.role
      : state.phase === "building"
        ? state.pipeline.builder.role
        : state.phase === "evaluating"
          ? state.pipeline.evaluator.role
          : state.phase === "maintaining"
            ? state.pipeline.maintainer?.role
            : undefined;
    if (!role) return;
    return {
      systemPrompt: `${event.systemPrompt}\n\nMateria active role (${state.phase}):\n${role.systemPrompt}`,
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
    description: "Run pi-materia commands: run, grid, status, continue, abort.",
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

      if (subcommand === "status") {
        const state = loadActiveCastState(ctx);
        if (!state) {
          ctx.ui.notify("No pi-materia cast state in this session.", "info");
          return;
        }
        const lines = [
          `Materia Cast ${state.castId}`,
          `active: ${state.active}`,
          `phase: ${state.phase}`,
          `awaiting response: ${state.awaitingResponse}`,
          `node: ${state.currentNode ?? "-"}`,
          `role: ${state.currentRole ?? "-"}`,
          `task: ${state.currentTaskId ? `${state.currentTaskId} - ${state.currentTaskTitle ?? ""}` : "-"}`,
          `attempt: ${state.attempt || "-"}`,
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

      if (subcommand !== "run") {
        ctx.ui.notify("Usage: /materia run <task>, /materia grid, /materia status, /materia continue, or /materia abort", "error");
        return;
      }

      const request = rest.join(" ").trim();
      if (!request) {
        ctx.ui.notify("Usage: /materia run <high-level software task>", "error");
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
        ctx.ui.notify(`pi-materia grid: ${pipeline.planner.id} -> ${pipeline.builder.id} -> ${pipeline.evaluator.id}${pipeline.maintainer ? ` -> ${pipeline.maintainer.id}` : ""}`, "info");
        await startNativeCast(pi, ctx, loaded, pipeline, request);
      } catch (error) {
        ctx.ui.setStatus("materia", "failed");
        ctx.ui.notify(`pi-materia cast failed to start: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });
}

function getConfiguredConfigPath(pi: ExtensionAPI): string | undefined {
  const flagValue = pi.getFlag("materia-config");
  if (typeof flagValue === "string" && flagValue.trim()) return flagValue.trim();
  if (process.env.MATERIA_CONFIG?.trim()) return process.env.MATERIA_CONFIG.trim();
  return undefined;
}
