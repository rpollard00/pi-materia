import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@mariozechner/pi-coding-agent";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

interface PiMateriaConfig {
  maxBuilderAttempts: number;
  autoCommit: boolean;
  commitCommand: string;
  artifactDir?: string;
  roles: Record<string, MateriaRoleConfig>;
}

interface LoadedConfig {
  config: PiMateriaConfig;
  source: string;
}

interface MateriaRoleConfig {
  tools: "none" | "readOnly" | "coding";
  systemPrompt: string;
}

interface PlannedTask {
  id: string;
  title: string;
  description: string;
  acceptance: string[];
}

interface PlanResult {
  tasks: PlannedTask[];
}

interface EvaluationResult {
  passed: boolean;
  feedback: string;
  missing?: string[];
}

const defaultConfig: PiMateriaConfig = {
  maxBuilderAttempts: 3,
  autoCommit: false,
  commitCommand: "git add -A && git commit -m",
  roles: {
    planner: {
      tools: "readOnly",
      systemPrompt:
        "You are the pi-materia planner. Break high-level software requests into small, ordered implementation tasks with objective acceptance criteria. Return only valid JSON when asked.",
    },
    builder: {
      tools: "coding",
      systemPrompt:
        "You are the pi-materia builder. Implement exactly the assigned task. Prefer small, safe edits. Run relevant checks. Stop when the task is complete or blocked.",
    },
    evaluator: {
      tools: "readOnly",
      systemPrompt:
        "You are the pi-materia evaluator. Verify whether the builder satisfied the task and acceptance criteria. Be strict. Return only valid JSON when asked.",
    },
    maintainer: {
      tools: "coding",
      systemPrompt:
        "You are the pi-materia maintainer. Prepare a clean final state, inspect git status/diff, and create a concise commit when instructed.",
    },
  },
};

export default function piMateria(pi: ExtensionAPI) {
  pi.registerFlag("materia-config", {
    description: "Path to a pi-materia loadout/config JSON file",
    type: "string",
  });

  pi.registerCommand("materia", {
    description: "Run pi-materia commands: run, grid, loadout, runs, inspect, tail.",
    handler: async (args, ctx) => {
      await ctx.waitForIdle();
      const [subcommand, ...rest] = args.trim().split(/\s+/).filter(Boolean);
      if (subcommand !== "run") {
        ctx.ui.notify("Usage: /materia run <high-level software task>", "error");
        return;
      }
      const request = rest.join(" ").trim();
      if (!request) {
        ctx.ui.notify("Usage: /materia run <high-level software task>", "error");
        return;
      }

      const loaded = await loadConfig(ctx.cwd, getConfiguredConfigPath(pi));
      const config = loaded.config;
      const artifactRoot = resolveArtifactRoot(ctx.cwd, config.artifactDir);
      const runDir = path.join(artifactRoot, safeTimestamp());
      await mkdir(runDir, { recursive: true });
      await writeFile(path.join(runDir, "config.resolved.json"), JSON.stringify(config, null, 2));
      pi.setSessionName(`materia: ${request.slice(0, 60)}`);
      pi.appendEntry("pi-materia-cast-start", {
        request,
        configSource: loaded.source,
        artifactRoot,
        runDir,
        startedAt: Date.now(),
      });
      ctx.ui.notify(`pi-materia config: ${loaded.source}`, "info");
      ctx.ui.notify(`pi-materia artifacts: ${runDir}`, "info");
      ctx.ui.setStatus("materia", "planning");

      try {
        const planText = await runRole(ctx.cwd, config.roles.planner, ctx.model, [
          "Create an implementation plan for this request.",
          "Return only JSON with shape: { \"tasks\": [{ \"id\": string, \"title\": string, \"description\": string, \"acceptance\": string[] }] }.",
          `Request: ${request}`,
        ].join("\n\n"));
        const plan = parseJson<PlanResult>(planText);
        await writeFile(path.join(runDir, "plan.json"), JSON.stringify(plan, null, 2));
        pi.appendEntry("pi-materia-plan", plan);
        ctx.ui.notify(`pi-materia planned ${plan.tasks.length} task(s).`, "info");

        for (const task of plan.tasks) {
          ctx.ui.setStatus("materia", `building ${task.id}`);
          let passed = false;
          let feedback = "";

          for (let attempt = 1; attempt <= config.maxBuilderAttempts; attempt++) {
            const buildPrompt = [
              `Task ${task.id}: ${task.title}`,
              task.description,
              `Acceptance criteria:\n${task.acceptance.map((a) => `- ${a}`).join("\n")}`,
              feedback ? `Previous evaluator feedback:\n${feedback}` : "",
              "Implement the task now. Run relevant checks and summarize what changed.",
            ].filter(Boolean).join("\n\n");

            const buildSummary = await runRole(ctx.cwd, config.roles.builder, ctx.model, buildPrompt);
            await writeFile(path.join(runDir, `${task.id}-build-${attempt}.md`), buildSummary);
            pi.appendEntry("pi-materia-build", { task, attempt, buildSummary });

            ctx.ui.setStatus("materia", `evaluating ${task.id}`);
            const evalText = await runRole(ctx.cwd, config.roles.evaluator, ctx.model, [
              "Evaluate whether the task is complete.",
              "Inspect the repository as needed. Return only JSON with shape: { \"passed\": boolean, \"feedback\": string, \"missing\": string[] }.",
              `Task: ${JSON.stringify(task, null, 2)}`,
              `Builder summary: ${buildSummary}`,
            ].join("\n\n"));
            const evaluation = parseJson<EvaluationResult>(evalText);
            await writeFile(path.join(runDir, `${task.id}-eval-${attempt}.json`), JSON.stringify(evaluation, null, 2));
            pi.appendEntry("pi-materia-evaluation", { task, attempt, evaluation });

            if (evaluation.passed) {
              passed = true;
              ctx.ui.notify(`pi-materia task ${task.id} passed.`, "info");
              break;
            }
            feedback = evaluation.feedback || evaluation.missing?.join("\n") || "Evaluator found unresolved issues.";
            ctx.ui.notify(`pi-materia task ${task.id} failed attempt ${attempt}; linking back to builder.`, "warning");
          }

          if (!passed) throw new Error(`Task ${task.id} did not pass after ${config.maxBuilderAttempts} attempts.`);
        }

        ctx.ui.setStatus("materia", "maintaining");
        const shouldCommit = config.autoCommit || (ctx.hasUI && await ctx.ui.confirm("pi-materia", "All tasks passed. Let maintainer commit the work?"));
        if (shouldCommit) {
          const maintainSummary = await runRole(ctx.cwd, config.roles.maintainer, ctx.model, [
            "All planned tasks passed evaluation.",
            "Inspect git status and diff. Commit the work with a concise message.",
            `Use this commit command pattern if you invoke git commit: ${config.commitCommand} "message"`,
          ].join("\n\n"));
          await writeFile(path.join(runDir, "maintainer.md"), maintainSummary);
          pi.appendEntry("pi-materia-maintainer", { maintainSummary });
        }

        pi.appendEntry("pi-materia-cast-end", { ok: true, endedAt: Date.now() });
        ctx.ui.setStatus("materia", "done");
        ctx.ui.notify("pi-materia cast complete.", "info");
      } catch (error) {
        pi.appendEntry("pi-materia-cast-end", { ok: false, error: String(error), endedAt: Date.now() });
        ctx.ui.setStatus("materia", "failed");
        ctx.ui.notify(`pi-materia cast failed: ${error instanceof Error ? error.message : String(error)}`, "error");
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

async function loadConfig(cwd: string, configuredPath?: string): Promise<LoadedConfig> {
  const explicitPath = configuredPath ? resolveFromCwd(cwd, configuredPath) : undefined;
  if (explicitPath) return loadConfigFile(explicitPath);

  const projectPath = path.join(cwd, ".pi", "pi-materia.json");
  if (existsSync(projectPath)) return loadConfigFile(projectPath);

  return {
    config: cloneDefaultConfig(),
    source: "<pi-materia default loadout>",
  };
}

async function loadConfigFile(file: string): Promise<LoadedConfig> {
  if (!existsSync(file)) throw new Error(`pi-materia config file not found: ${file}`);
  const parsed = JSON.parse(await readFile(file, "utf8")) as Partial<PiMateriaConfig>;
  return {
    config: mergeConfig(parsed),
    source: file,
  };
}

function mergeConfig(parsed: Partial<PiMateriaConfig>): PiMateriaConfig {
  return {
    ...cloneDefaultConfig(),
    ...parsed,
    roles: { ...defaultConfig.roles, ...(parsed.roles ?? {}) },
  };
}

function cloneDefaultConfig(): PiMateriaConfig {
  return JSON.parse(JSON.stringify(defaultConfig)) as PiMateriaConfig;
}

function resolveArtifactRoot(cwd: string, artifactDir?: string): string {
  return artifactDir ? resolveFromCwd(cwd, artifactDir) : path.join(cwd, ".pi", "pi-materia");
}

function resolveFromCwd(cwd: string, inputPath: string): string {
  return path.isAbsolute(inputPath) ? inputPath : path.resolve(cwd, inputPath);
}

async function runRole(cwd: string, role: MateriaRoleConfig, model: unknown, prompt: string): Promise<string> {
  const agentDir = getAgentDir();
  const settingsManager = SettingsManager.create(cwd, agentDir);
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    systemPromptOverride: () => role.systemPrompt,
  });
  await loader.reload();

  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);
  const tools = selectTools(role.tools);
  let output = "";

  const { session } = await createAgentSession({
    cwd,
    model: model as never,
    authStorage,
    modelRegistry,
    settingsManager,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(),
    tools,
  });

  const unsubscribe = session.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      output += event.assistantMessageEvent.delta;
    }
  });

  try {
    await session.prompt(prompt, { source: "extension" });
    return output.trim();
  } finally {
    unsubscribe();
    session.dispose();
  }
}

function selectTools(kind: MateriaRoleConfig["tools"]): string[] {
  if (kind === "coding") return ["read", "bash", "edit", "write"];
  if (kind === "readOnly") return ["read", "grep", "find", "ls"];
  return [];
}

function parseJson<T>(text: string): T {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = (fenced ?? text).trim();
  const start = Math.min(
    ...[candidate.indexOf("{"), candidate.indexOf("[")].filter((i) => i >= 0),
  );
  if (!Number.isFinite(start)) throw new Error(`No JSON found in agent output: ${text.slice(0, 400)}`);
  return JSON.parse(candidate.slice(start)) as T;
}

function safeTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}
