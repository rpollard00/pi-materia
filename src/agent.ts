import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@mariozechner/pi-coding-agent";
import { appendEvent } from "./artifacts.js";
import type { MateriaRoleConfig, RoleRunContext } from "./types.js";
import { addUsage, extractUsage, writeUsage } from "./usage.js";

export async function runRole(cwd: string, role: MateriaRoleConfig, model: unknown, prompt: string, context?: RoleRunContext): Promise<string> {
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

  if (context) {
    context.runState.currentNode = context.nodeId;
    context.runState.currentRole = context.roleName;
    context.runState.currentTask = context.taskId;
    context.runState.attempt = context.attempt;
    context.runState.lastMessage = "starting";
    context.update();
    await appendEvent(context.runState, "role_start", {
      node: context.nodeId,
      role: context.roleName,
      taskId: context.taskId,
      attempt: context.attempt,
    });
  }

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
      if (context) {
        context.runState.lastMessage = summarizeText(output);
        context.update();
      }
    }
    if (context && event.type === "message_update") {
      const assistantEvent = event.assistantMessageEvent as { type: string; message?: unknown; error?: unknown };
      const maybeMessage = assistantEvent.type === "done" ? assistantEvent.message : assistantEvent.type === "error" ? assistantEvent.error : undefined;
      const usage = extractUsage(maybeMessage);
      if (usage) {
        addUsage(context.runState.usage, usage, {
          node: context.nodeId,
          role: context.roleName,
          taskId: context.taskId,
          attempt: context.attempt,
        });
        context.update();
        void writeUsage(context.runState);
      }
    }
  });

  try {
    await session.prompt(prompt, { source: "extension" });
    if (context) {
      await appendEvent(context.runState, "role_end", {
        node: context.nodeId,
        role: context.roleName,
        taskId: context.taskId,
        attempt: context.attempt,
      });
    }
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

function summarizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(-120) || "streaming";
}
