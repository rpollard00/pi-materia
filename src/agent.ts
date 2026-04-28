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
    context.mirror?.({ type: "role_start" });
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

  let mirroredText = "";
  const unsubscribe = session.subscribe((event) => {
    if (context) logAgentEvent(context, event);
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      output += event.assistantMessageEvent.delta;
      if (context) {
        mirroredText += event.assistantMessageEvent.delta;
        if (mirroredText.length >= 1200 || /\n\s*[-*]\s|\n#{1,3}\s|\n```/.test(mirroredText)) {
          context.mirror?.({ type: "text_chunk", text: mirroredText });
          mirroredText = "";
        }
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
      if (mirroredText.trim()) context.mirror?.({ type: "text_chunk", text: mirroredText });
      context.mirror?.({ type: "role_end", output: output.trim() });
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

function logAgentEvent(context: RoleRunContext, event: { type: string; [key: string]: unknown }): void {
  const base = {
    node: context.nodeId,
    role: context.roleName,
    taskId: context.taskId,
    attempt: context.attempt,
  };

  switch (event.type) {
    case "turn_start":
      void appendEvent(context.runState, "agent_turn_start", { ...base, turnIndex: event.turnIndex });
      break;
    case "turn_end":
      void appendEvent(context.runState, "agent_turn_end", { ...base, turnIndex: event.turnIndex, toolResults: summarizeToolResults(event.toolResults) });
      break;
    case "message_start":
      void appendEvent(context.runState, "agent_message_start", { ...base, message: summarizeMessage(event.message) });
      break;
    case "message_end":
      void appendEvent(context.runState, "agent_message_end", { ...base, message: summarizeMessage(event.message) });
      break;
    case "tool_execution_start":
      context.runState.lastMessage = `tool: ${String(event.toolName)}`;
      context.update();
      context.mirror?.({ type: "tool_start", toolName: String(event.toolName), args: event.args });
      void appendEvent(context.runState, "agent_tool_start", { ...base, toolCallId: event.toolCallId, toolName: event.toolName, args: event.args });
      break;
    case "tool_execution_update":
      void appendEvent(context.runState, "agent_tool_update", { ...base, toolCallId: event.toolCallId, toolName: event.toolName, partialResult: summarizeUnknown(event.partialResult) });
      break;
    case "tool_execution_end":
      context.runState.lastMessage = `tool done: ${String(event.toolName)}`;
      context.update();
      context.mirror?.({ type: "tool_end", toolName: String(event.toolName), isError: Boolean(event.isError), result: summarizeUnknown(event.result) });
      void appendEvent(context.runState, "agent_tool_end", { ...base, toolCallId: event.toolCallId, toolName: event.toolName, isError: event.isError, result: summarizeUnknown(event.result) });
      break;
    case "agent_end":
      void appendEvent(context.runState, "agent_end", { ...base });
      break;
  }
}

function summarizeToolResults(value: unknown): unknown {
  if (!Array.isArray(value)) return undefined;
  return value.map(summarizeMessage);
}

function summarizeMessage(value: unknown): unknown {
  const message = value as { role?: unknown; content?: unknown; stopReason?: unknown; errorMessage?: unknown; usage?: { totalTokens?: unknown; cost?: { total?: unknown } } } | undefined;
  if (!message) return undefined;
  return {
    role: message.role,
    stopReason: message.stopReason,
    errorMessage: message.errorMessage,
    text: summarizeUnknown(message.content),
    usage: message.usage ? { totalTokens: message.usage.totalTokens, cost: message.usage.cost?.total } : undefined,
  };
}

function summarizeUnknown(value: unknown): unknown {
  if (typeof value === "string") return summarizeText(value);
  if (Array.isArray(value)) return value.map((item) => summarizeUnknown(item));
  if (value && typeof value === "object") {
    try {
      return summarizeText(JSON.stringify(value));
    } catch {
      return "[unserializable object]";
    }
  }
  return value;
}

function selectTools(kind: MateriaRoleConfig["tools"]): string[] {
  if (kind === "coding") return ["read", "bash", "edit", "write"];
  if (kind === "readOnly") return ["read", "grep", "find", "ls"];
  return [];
}

function summarizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(-120) || "streaming";
}
