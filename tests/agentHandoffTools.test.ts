import { describe, expect, test } from "bun:test";
import { validateToolArguments, type ToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { deriveSocketOutputRequirements } from "../src/handoff/socketOutputRequirements.js";
import {
  AgentHandoffBuilder,
  type AgentHandoffBuilderOptions,
  type AgentHandoffCommit,
} from "../src/runtime/agentHandoffBuilder.js";
import {
  AGENT_HANDOFF_TOOL_NAME_LIST,
  AGENT_HANDOFF_TOOL_NAMES,
  createAgentHandoffTools,
  exposeAgentHandoffTools,
  hideAgentHandoffTools,
} from "../src/runtime/agentHandoffTools.js";

const scope = {
  castId: "cast-tools",
  socketId: "Socket-Tools",
  socketVisit: 1,
  finalizationAttempt: 1,
};

function builderOptions(input: {
  socket?: Parameters<typeof deriveSocketOutputRequirements>[0]["socket"];
  workItemsProducer?: boolean;
  allowEventSideChannel?: boolean;
} = {}): AgentHandoffBuilderOptions {
  const socket = input.socket ?? { parse: "json" as const };
  return {
    scope,
    requirements: deriveSocketOutputRequirements({
      socket,
      socketId: scope.socketId,
      workItemsProducer: input.workItemsProducer,
    }),
    workItemsProducer: input.workItemsProducer,
    allowEventSideChannel: input.allowEventSideChannel,
  };
}

function validateArguments(tool: ToolDefinition, args: Record<string, unknown>): Record<string, unknown> {
  const call: ToolCall = {
    type: "toolCall",
    id: `call-${tool.name}`,
    name: tool.name,
    arguments: args,
  };
  return validateToolArguments(tool, call) as Record<string, unknown>;
}

async function invoke(tool: ToolDefinition, args: Record<string, unknown> = {}) {
  return tool.execute(
    `call-${tool.name}`,
    validateArguments(tool, args),
    undefined,
    undefined,
    {} as ExtensionContext,
  );
}

describe("ergonomic agent handoff tools", () => {
  test("derives tool availability from active socket capabilities", () => {
    const sparse = createAgentHandoffTools({
      builder: new AgentHandoffBuilder(builderOptions()),
    });
    expect(sparse.capabilities).toEqual({
      workItems: false,
      satisfied: false,
      context: true,
      events: true,
    });
    expect(sparse.names).toEqual([
      AGENT_HANDOFF_TOOL_NAMES.setContext,
      AGENT_HANDOFF_TOOL_NAMES.emitEvent,
      AGENT_HANDOFF_TOOL_NAMES.commit,
    ]);
    expect(sparse.tools.addWorkItem).toBeUndefined();
    expect(sparse.tools.setSatisfied).toBeUndefined();

    const graphControl = createAgentHandoffTools({
      builder: new AgentHandoffBuilder(builderOptions({
        socket: {
          parse: "json",
          assign: { workItems: "$.workItems" },
          edges: [{ when: "satisfied", to: "end" }],
        },
        workItemsProducer: true,
        allowEventSideChannel: false,
      })),
    });
    expect(graphControl.capabilities).toEqual({
      workItems: true,
      satisfied: true,
      context: true,
      events: false,
    });
    expect(graphControl.names).toEqual([
      AGENT_HANDOFF_TOOL_NAMES.beginWorkItems,
      AGENT_HANDOFF_TOOL_NAMES.addWorkItem,
      AGENT_HANDOFF_TOOL_NAMES.setSatisfied,
      AGENT_HANDOFF_TOOL_NAMES.setContext,
      AGENT_HANDOFF_TOOL_NAMES.commit,
    ]);
    expect(graphControl.tools.emitEvent).toBeUndefined();
    expect(graphControl.definitions.every((tool) => tool.executionMode === "sequential")).toBe(true);
  });

  test("uses narrow schemas and Pi validation before builder execution", () => {
    const toolSet = createAgentHandoffTools({
      builder: new AgentHandoffBuilder(builderOptions({ workItemsProducer: true })),
    });
    const add = toolSet.tools.addWorkItem!;
    const emit = toolSet.tools.emitEvent!;

    expect(() => validateArguments(add, {
      title: "feat: invalid aggregate",
      context: "One item only.",
      workItems: [],
    })).toThrow(/Validation failed/);
    expect(() => validateArguments(emit, {
      type: "status.progress",
      severity: "fatal",
    })).toThrow(/Validation failed/);
    expect(() => validateArguments(emit, {
      type: "status.progress",
      payload: "not an object",
    })).toThrow(/Validation failed/);
    expect(() => validateArguments(emit, {
      type: "status.progress",
      runtimeSequence: 3,
    })).toThrow(/Validation failed/);

    const schemas = toolSet.definitions.map((tool) => tool.parameters as { properties?: Record<string, unknown> });
    expect(schemas.some((schema) => Object.prototype.hasOwnProperty.call(schema.properties ?? {}, "workItems"))).toBe(false);
    expect(schemas.some((schema) => Object.prototype.hasOwnProperty.call(schema.properties ?? {}, "event"))).toBe(false);
    expect(toolSet.builder.snapshot()).toEqual({});
  });

  test("returns concise field-level contract feedback when commit is incomplete", async () => {
    const toolSet = createAgentHandoffTools({
      builder: new AgentHandoffBuilder(builderOptions({
        socket: {
          parse: "json",
          assign: { workItems: "$.workItems" },
          edges: [{ when: "satisfied", to: "done" }],
        },
        workItemsProducer: true,
      })),
    });

    await expect(invoke(toolSet.tools.commit)).rejects.toThrow(/Materia handoff contract violation/);
    await expect(invoke(toolSet.tools.commit)).rejects.toThrow(/\$\.workItems/);
  });

  test("omits untouched optional fields and rejects duplicate tool commits", async () => {
    const commits: AgentHandoffCommit[] = [];
    const toolSet = createAgentHandoffTools({
      builder: new AgentHandoffBuilder(builderOptions()),
      onCommit: (commit) => commits.push(commit),
    });

    const result = await invoke(toolSet.tools.commit);

    expect(result.terminate).toBe(true);
    expect(commits).toHaveLength(1);
    expect(commits[0]?.output).toEqual({});
    expect(commits[0]?.json).toBe("{}");
    await expect(invoke(toolSet.tools.commit)).rejects.toThrow(/protocol violation/);
    await expect(invoke(toolSet.tools.setContext, { context: "too late" })).rejects.toThrow(/protocol violation/);
    expect(commits).toHaveLength(1);
  });

  test("accumulates ordered values and commits runtime-owned escaping and event serialization", async () => {
    const commits: AgentHandoffCommit[] = [];
    const toolSet = createAgentHandoffTools({
      builder: new AgentHandoffBuilder(builderOptions({
        socket: {
          parse: "json",
          assign: { workItems: "$.workItems" },
          edges: [{ when: "satisfied", to: "done" }],
        },
        workItemsProducer: true,
      })),
      onCommit: (commit) => commits.push(commit),
    });

    await invoke(toolSet.tools.setContext, {
      context: "Quoted \"value\"\nC:\\repo\\materia; 東京 🧪 and literal \\n",
    });
    await invoke(toolSet.tools.addWorkItem!, {
      title: "feat: preserve \"quotes\"",
      context: "Use C:\\repo.\nKeep \\n literal.",
    });
    await invoke(toolSet.tools.addWorkItem!, {
      title: "test: preserve Unicode 東京",
      context: "Keep combining é and emoji 🚀.",
    });
    await invoke(toolSet.tools.setSatisfied!, { satisfied: true });
    await invoke(toolSet.tools.emitEvent!, {
      type: "status.progress",
      message: "First \"event\"\nnext",
      payload: { z: "last", nested: { y: 2, x: 1 }, a: "first" },
    });
    await invoke(toolSet.tools.emitEvent!, { type: "result.no_changes_needed" });
    const result = await invoke(toolSet.tools.commit);

    expect(result.terminate).toBe(true);
    expect(commits).toHaveLength(1);
    expect(JSON.parse(commits[0]!.json)).toEqual({
      workItems: [
        {
          title: "feat: preserve \"quotes\"",
          context: "Use C:\\repo.\nKeep \\n literal.",
        },
        {
          title: "test: preserve Unicode 東京",
          context: "Keep combining é and emoji 🚀.",
        },
      ],
      satisfied: true,
      context: "Quoted \"value\"\nC:\\repo\\materia; 東京 🧪 and literal \\n",
      event: [
        {
          type: "status.progress",
          message: "First \"event\"\nnext",
          payload: { a: "first", nested: { x: 1, y: 2 }, z: "last" },
        },
        { type: "result.no_changes_needed" },
      ],
    });
    expect((result.details as { workItemCount: number; eventCount: number })).toMatchObject({
      workItemCount: 2,
      eventCount: 2,
    });
  });

  test("activation removes stale unsupported handoff tools and preserves unrelated tools", () => {
    const registered = new Map<string, ToolDefinition>();
    let active = ["read", ...AGENT_HANDOFF_TOOL_NAME_LIST];
    const pi = {
      registerTool: (tool: ToolDefinition) => registered.set(tool.name, tool),
      getActiveTools: () => [...active],
      setActiveTools: (names: string[]) => { active = [...names]; },
    } as unknown as ExtensionAPI;

    const exposed = exposeAgentHandoffTools(pi, {
      builder: new AgentHandoffBuilder(builderOptions({ allowEventSideChannel: false })),
    });

    expect([...registered.keys()]).toEqual(exposed.names);
    expect(active).toEqual([
      "read",
      AGENT_HANDOFF_TOOL_NAMES.setContext,
      AGENT_HANDOFF_TOOL_NAMES.commit,
    ]);

    hideAgentHandoffTools(pi);
    expect(active).toEqual(["read"]);
  });
});
