import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { runRole } from "./agent.js";
import { appendEvent, safePathSegment, safeTimestamp } from "./artifacts.js";
import { loadConfig, resolveArtifactRoot } from "./config.js";
import { parseJson } from "./json.js";
import { renderGrid, resolvePipeline } from "./pipeline.js";
import type {
  EvaluationResult,
  MateriaMirrorEvent,
  MateriaRunState,
  PlanResult,
} from "./types.js";
import { showUsageSummary, updateWidget } from "./ui.js";
import { assertBudget, createRunState, writeUsage } from "./usage.js";

export default function piMateria(pi: ExtensionAPI) {
  pi.registerFlag("materia-config", {
    description: "Path to a pi-materia loadout/config JSON file",
    type: "string",
  });

  pi.registerCommand("materia", {
    description:
      "Run pi-materia commands: run, grid, loadout, runs, inspect, tail, cast.",
    handler: async (args, ctx) => {
      await ctx.waitForIdle();
      const [subcommand, ...rest] = args.trim().split(/\s+/).filter(Boolean);

      if (subcommand === "grid") {
        try {
          const loaded = await loadConfig(ctx.cwd, getConfiguredConfigPath(pi));
          const pipeline = resolvePipeline(loaded.config);
          const lines = renderGrid(
            loaded.config,
            pipeline,
            loaded.source,
            ctx.cwd,
          );
          ctx.ui.setWidget("materia-grid", lines, { placement: "belowEditor" });
          ctx.ui.notify(`pi-materia grid loaded from ${loaded.source}`, "info");
          pi.appendEntry("pi-materia-grid", { source: loaded.source, lines });
        } catch (error) {
          ctx.ui.notify(
            `pi-materia grid failed: ${error instanceof Error ? error.message : String(error)}`,
            "error",
          );
        }
        return;
      }

      if (subcommand !== "run") {
        ctx.ui.notify("Usage: /materia run <task> or /materia grid", "error");
        return;
      }

      const request = rest.join(" ").trim();
      if (!request) {
        ctx.ui.notify(
          "Usage: /materia run <high-level software task>",
          "error",
        );
        return;
      }

      let runState: MateriaRunState | undefined;
      try {
        const loaded = await loadConfig(ctx.cwd, getConfiguredConfigPath(pi));
        const config = loaded.config;
        const pipeline = resolvePipeline(config);
        const artifactRoot = resolveArtifactRoot(ctx.cwd, config.artifactDir);
        const runId = safeTimestamp();
        const runDir = path.join(artifactRoot, runId);
        await mkdir(path.join(runDir, "tasks"), { recursive: true });
        await mkdir(path.join(runDir, "maintenance"), { recursive: true });
        await writeFile(
          path.join(runDir, "config.resolved.json"),
          JSON.stringify(config, null, 2),
        );

        runState = createRunState(runId, runDir, ctx.model);
        await writeUsage(runState);
        await appendEvent(runState, "cast_start", {
          request,
          configSource: loaded.source,
          artifactRoot,
          pipeline: config.pipeline,
        });

        pi.setSessionName(`materia: ${request.slice(0, 60)}`);
        pi.appendEntry("pi-materia-cast-start", {
          request,
          configSource: loaded.source,
          artifactRoot,
          runDir,
          pipeline: config.pipeline,
          startedAt: Date.now(),
        });
        ctx.ui.notify(`pi-materia config: ${loaded.source}`, "info");
        ctx.ui.notify(`pi-materia artifacts: ${runDir}`, "info");
        ctx.ui.notify(
          `pi-materia grid: ${pipeline.planner.id} -> ${pipeline.builder.id} -> ${pipeline.evaluator.id}` +
            (pipeline.maintainer ? ` -> ${pipeline.maintainer.id}` : ""),
          "info",
        );

        ctx.ui.setStatus("materia", `planning:${pipeline.planner.id}`);
        updateWidget(ctx, runState);

        const planText = await runRole(
          ctx.cwd,
          pipeline.planner.role,
          ctx.model,
          [
            "Create an implementation plan for this request.",
            'Return only JSON with shape: { "tasks": [{ "id": string, "title": string, "description": string, "acceptance": string[] }] }.',
            `Request: ${request}`,
          ].join("\n\n"),
          {
            nodeId: pipeline.planner.id,
            roleName: pipeline.planner.node.role,
            runState,
            update: () => updateWidget(ctx, runState as MateriaRunState),
            mirror: createMirror(
              pi,
              pipeline.planner.id,
              pipeline.planner.node.role,
            ),
          },
        );
        const plan = parseJson<PlanResult>(planText);
        await writeFile(
          path.join(runDir, "plan.json"),
          JSON.stringify(plan, null, 2),
        );
        await appendEvent(runState, "plan", plan);
        pi.appendEntry("pi-materia-plan", plan);
        ctx.ui.notify(
          `pi-materia planned ${plan.tasks.length} task(s).`,
          "info",
        );

        for (const task of plan.tasks) {
          const taskDir = path.join(runDir, "tasks", safePathSegment(task.id));
          await mkdir(taskDir, { recursive: true });
          await appendEvent(runState, "task_start", { task });
          ctx.ui.setStatus("materia", `${pipeline.builder.id}:${task.id}`);
          let passed = false;
          let feedback = "";

          for (
            let attempt = 1;
            attempt <= config.maxBuilderAttempts;
            attempt++
          ) {
            const buildPrompt = [
              `Task ${task.id}: ${task.title}`,
              task.description,
              `Acceptance criteria:\n${task.acceptance.map((a) => `- ${a}`).join("\n")}`,
              feedback ? `Previous evaluator feedback:\n${feedback}` : "",
              "Implement the task now. Run relevant checks and summarize what changed.",
            ]
              .filter(Boolean)
              .join("\n\n");

            const buildSummary = await runRole(
              ctx.cwd,
              pipeline.builder.role,
              ctx.model,
              buildPrompt,
              {
                nodeId: pipeline.builder.id,
                roleName: pipeline.builder.node.role,
                taskId: task.id,
                taskTitle: task.title,
                attempt,
                runState,
                update: () => updateWidget(ctx, runState as MateriaRunState),
                mirror: createMirror(
                  pi,
                  pipeline.builder.id,
                  pipeline.builder.node.role,
                  task.id,
                  task.title,
                  attempt,
                ),
              },
            );
            await writeFile(
              path.join(taskDir, `build-${attempt}.md`),
              buildSummary,
            );
            await appendEvent(runState, "build", {
              taskId: task.id,
              attempt,
              node: pipeline.builder.id,
            });
            await assertBudget(config, runState, ctx);
            pi.appendEntry("pi-materia-build", { task, attempt, buildSummary });

            ctx.ui.setStatus("materia", `${pipeline.evaluator.id}:${task.id}`);
            const evalText = await runRole(
              ctx.cwd,
              pipeline.evaluator.role,
              ctx.model,
              [
                "Evaluate whether the task is complete.",
                'Inspect the repository as needed. Return only JSON with shape: { "passed": boolean, "feedback": string, "missing": string[] }.',
                `Task: ${JSON.stringify(task, null, 2)}`,
                `Builder summary: ${buildSummary}`,
              ].join("\n\n"),
              {
                nodeId: pipeline.evaluator.id,
                roleName: pipeline.evaluator.node.role,
                taskId: task.id,
                taskTitle: task.title,
                attempt,
                runState,
                update: () => updateWidget(ctx, runState as MateriaRunState),
                mirror: createMirror(
                  pi,
                  pipeline.evaluator.id,
                  pipeline.evaluator.node.role,
                  task.id,
                  task.title,
                  attempt,
                ),
              },
            );
            const evaluation = parseJson<EvaluationResult>(evalText);
            await writeFile(
              path.join(taskDir, `eval-${attempt}.json`),
              JSON.stringify(evaluation, null, 2),
            );
            await appendEvent(runState, "evaluation", {
              taskId: task.id,
              attempt,
              node: pipeline.evaluator.id,
              evaluation,
            });
            await assertBudget(config, runState, ctx);
            pi.appendEntry("pi-materia-evaluation", {
              task,
              attempt,
              evaluation,
            });

            if (evaluation.passed) {
              passed = true;
              ctx.ui.notify(`pi-materia task ${task.id} passed.`, "info");
              break;
            }
            feedback =
              evaluation.feedback ||
              evaluation.missing?.join("\n") ||
              "Evaluator found unresolved issues.";
            ctx.ui.notify(
              `pi-materia task ${task.id} failed attempt ${attempt}; linking back to builder.`,
              "warning",
            );
          }

          if (!passed)
            throw new Error(
              `Task ${task.id} did not pass after ${config.maxBuilderAttempts} attempts.`,
            );
        }

        ctx.ui.setStatus(
          "materia",
          pipeline.maintainer
            ? `maintaining:${pipeline.maintainer.id}`
            : "complete",
        );
        const shouldCommit =
          Boolean(pipeline.maintainer) &&
          (config.autoCommit ||
            (ctx.hasUI &&
              (await ctx.ui.confirm(
                "pi-materia",
                "All tasks passed. Let maintainer commit the work?",
              ))));
        if (shouldCommit && pipeline.maintainer) {
          const maintainSummary = await runRole(
            ctx.cwd,
            pipeline.maintainer.role,
            ctx.model,
            [
              "All planned tasks passed evaluation.",
              "Inspect the repository state and create an appropriate checkpoint/commit only if you are satisfied with the final state.",
              "Follow your maintainer role system prompt for the correct VCS commands.",
            ].join("\n\n"),
            {
              nodeId: pipeline.maintainer.id,
              roleName: pipeline.maintainer.node.role,
              runState,
              update: () => updateWidget(ctx, runState as MateriaRunState),
              mirror: createMirror(
                pi,
                pipeline.maintainer.id,
                pipeline.maintainer.node.role,
              ),
            },
          );
          await writeFile(
            path.join(runDir, "maintenance", "final.md"),
            maintainSummary,
          );
          await appendEvent(runState, "maintenance", {
            node: pipeline.maintainer.id,
          });
          await assertBudget(config, runState, ctx);
          pi.appendEntry("pi-materia-maintainer", { maintainSummary });
        }

        await writeUsage(runState);
        await appendEvent(runState, "cast_end", {
          ok: true,
          usage: runState.usage,
        });
        pi.appendEntry("pi-materia-cast-end", {
          ok: true,
          usage: runState.usage,
          endedAt: Date.now(),
        });
        ctx.ui.setStatus("materia", "done");
        updateWidget(ctx, runState);
        showUsageSummary(ctx, runState);
        ctx.ui.notify(
          `pi-materia cast complete. Tokens: ${runState.usage.tokens.total}, cost: $${runState.usage.cost.total.toFixed(4)}`,
          "info",
        );
      } catch (error) {
        if (runState) {
          await appendEvent(runState, "cast_end", {
            ok: false,
            error: String(error),
          });
          await writeUsage(runState);
        }
        pi.appendEntry("pi-materia-cast-end", {
          ok: false,
          error: String(error),
          endedAt: Date.now(),
        });
        ctx.ui.setStatus("materia", "failed");
        ctx.ui.notify(
          `pi-materia cast failed: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      }
    },
  });
}

function createMirror(
  pi: ExtensionAPI,
  nodeId: string,
  roleName: string,
  taskId?: string,
  taskTitle?: string,
  attempt?: number,
): (event: MateriaMirrorEvent) => void {
  const prefix = taskId
    ? `${nodeId}:${taskId}${taskTitle ? ` - ${taskTitle}` : ""}${attempt ? ` (attempt ${attempt})` : ""}`
    : nodeId;
  let eventCount = 0;

  return (event) => {
    const content = renderMirrorEvent(prefix, roleName, event, ++eventCount);
    if (!content) return;
    pi.sendMessage({
      customType: "pi-materia",
      content,
      display: true,
      details: {
        nodeId,
        roleName,
        taskId,
        taskTitle,
        attempt,
        eventType: event.type,
      },
    });
    pi.appendEntry("pi-materia-mirror", { nodeId, roleName, taskId, taskTitle, attempt, eventType: event.type, content });
  };
}

function renderMirrorEvent(
  prefix: string,
  roleName: string,
  event: MateriaMirrorEvent,
  eventCount: number,
): string | undefined {
  switch (event.type) {
    case "role_start":
      return `## Materia: ${prefix}\n\nStarting **${roleName}**.`;
    case "text_chunk":
      return event.text.trim()
        ? `### Materia output: ${prefix}\n\n${event.text.trim()}`
        : undefined;
    case "tool_start":
      return `### Materia tool: ${prefix}\n\nRunning \`${event.toolName}\`\n\n${formatMirrorValue(event.args)}`;
    case "tool_end":
      return `### Materia tool ${event.isError ? "failed" : "finished"}: ${prefix}\n\n\`${event.toolName}\`\n\n${formatMirrorValue(event.result)}`;
    case "role_end":
      return eventCount <= 2 && event.output
        ? `### Materia completed: ${prefix}\n\n${event.output}`
        : `### Materia completed: ${prefix}`;
  }
}

function formatMirrorValue(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string") return truncate(value);
  try {
    return "```json\n" + truncate(JSON.stringify(value, null, 2)) + "\n```";
  } catch {
    return String(value);
  }
}

function truncate(value: string, max = 4000): string {
  return value.length > max ? `${value.slice(0, max)}\n\n… truncated …` : value;
}

function getConfiguredConfigPath(pi: ExtensionAPI): string | undefined {
  const flagValue = pi.getFlag("materia-config");
  if (typeof flagValue === "string" && flagValue.trim())
    return flagValue.trim();
  if (process.env.MATERIA_CONFIG?.trim())
    return process.env.MATERIA_CONFIG.trim();
  return undefined;
}
