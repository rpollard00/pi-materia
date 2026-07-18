import {
  StringEnum,
  Type,
  type Static,
} from "@earendil-works/pi-ai";
import {
  defineTool,
  type ExtensionAPI,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { EVENT_SEVERITY_LEVELS } from "../domain/eventing.js";
import {
  AgentHandoffBuilder,
  type AgentHandoffCapabilities,
  type AgentHandoffCommit,
} from "./agentHandoffBuilder.js";
import { cloneAgentHandoffBuilderScope } from "./agentHandoffBuilderTypes.js";

export const AGENT_HANDOFF_TOOL_NAMES = {
  beginWorkItems: "materia_handoff_begin_work_items",
  addWorkItem: "materia_handoff_add_work_item",
  setSatisfied: "materia_handoff_set_satisfied",
  setContext: "materia_handoff_set_context",
  emitEvent: "materia_handoff_emit_event",
  commit: "materia_handoff_commit",
} as const;

export type AgentHandoffToolName = (typeof AGENT_HANDOFF_TOOL_NAMES)[keyof typeof AGENT_HANDOFF_TOOL_NAMES];

export const AGENT_HANDOFF_TOOL_NAME_LIST: readonly AgentHandoffToolName[] = Object.freeze(
  Object.values(AGENT_HANDOFF_TOOL_NAMES),
);

export const BEGIN_AGENT_HANDOFF_WORK_ITEMS_PARAMETERS = Type.Object({}, { additionalProperties: false });
export const ADD_AGENT_HANDOFF_WORK_ITEM_PARAMETERS = Type.Object({
  title: Type.String({ minLength: 1, description: "Work item title" }),
  context: Type.String({ minLength: 1, description: "All item-specific implementation guidance" }),
}, { additionalProperties: false });
export const SET_AGENT_HANDOFF_SATISFIED_PARAMETERS = Type.Object({
  satisfied: Type.Boolean({ description: "Canonical satisfied/not_satisfied graph-control result" }),
}, { additionalProperties: false });
export const SET_AGENT_HANDOFF_CONTEXT_PARAMETERS = Type.Object({
  context: Type.String({ description: "Optional explanatory handoff notes for downstream agents" }),
}, { additionalProperties: false });
const AGENT_HANDOFF_EVENT_SOURCE_PARAMETERS = Type.Object({
  materia: Type.Optional(Type.String({ description: "Optional self-reported materia id" })),
  socketId: Type.Optional(Type.String({ description: "Optional self-reported socket id" })),
}, { additionalProperties: false });
const AGENT_HANDOFF_EVENT_PAYLOAD_PARAMETERS = Type.Object({}, {
  additionalProperties: true,
  description: "Optional JSON object with type-specific event data",
});
export const EMIT_AGENT_HANDOFF_EVENT_PARAMETERS = Type.Object({
  type: Type.String({ minLength: 1, description: "Dot-separated event kind, for example status.progress" }),
  severity: Type.Optional(StringEnum(EVENT_SEVERITY_LEVELS, { description: "Optional event severity" })),
  message: Type.Optional(Type.String({ description: "Optional human-readable event summary" })),
  payload: Type.Optional(AGENT_HANDOFF_EVENT_PAYLOAD_PARAMETERS),
  source: Type.Optional(AGENT_HANDOFF_EVENT_SOURCE_PARAMETERS),
}, { additionalProperties: false });
export const COMMIT_AGENT_HANDOFF_PARAMETERS = Type.Object({}, { additionalProperties: false });

export type AddAgentHandoffWorkItemInput = Static<typeof ADD_AGENT_HANDOFF_WORK_ITEM_PARAMETERS>;
export type SetAgentHandoffSatisfiedInput = Static<typeof SET_AGENT_HANDOFF_SATISFIED_PARAMETERS>;
export type SetAgentHandoffContextInput = Static<typeof SET_AGENT_HANDOFF_CONTEXT_PARAMETERS>;
export type EmitAgentHandoffEventInput = Static<typeof EMIT_AGENT_HANDOFF_EVENT_PARAMETERS>;

export interface AgentHandoffToolDetails {
  readonly action: "begin_work_items" | "add_work_item" | "set_satisfied" | "set_context" | "emit_event" | "commit";
  readonly scope: ReturnType<typeof cloneAgentHandoffBuilderScope>;
  readonly field?: "workItems" | "satisfied" | "context" | "event";
  readonly workItemCount: number;
  readonly eventCount: number;
  readonly committed: boolean;
  readonly fields?: readonly string[];
  readonly jsonBytes?: number;
}

export interface AgentHandoffToolsByCapability {
  readonly beginWorkItems?: ToolDefinition<typeof BEGIN_AGENT_HANDOFF_WORK_ITEMS_PARAMETERS, AgentHandoffToolDetails>;
  readonly addWorkItem?: ToolDefinition<typeof ADD_AGENT_HANDOFF_WORK_ITEM_PARAMETERS, AgentHandoffToolDetails>;
  readonly setSatisfied?: ToolDefinition<typeof SET_AGENT_HANDOFF_SATISFIED_PARAMETERS, AgentHandoffToolDetails>;
  readonly setContext: ToolDefinition<typeof SET_AGENT_HANDOFF_CONTEXT_PARAMETERS, AgentHandoffToolDetails>;
  readonly emitEvent?: ToolDefinition<typeof EMIT_AGENT_HANDOFF_EVENT_PARAMETERS, AgentHandoffToolDetails>;
  readonly commit: ToolDefinition<typeof COMMIT_AGENT_HANDOFF_PARAMETERS, AgentHandoffToolDetails>;
}

export interface AgentHandoffToolSet {
  readonly builder: AgentHandoffBuilder;
  readonly capabilities: AgentHandoffCapabilities;
  /** Definitions in recommended prompt order; only socket-applicable tools are present. */
  readonly definitions: readonly ToolDefinition[];
  /** Named access to the same definitions. Unsupported capability keys are absent. */
  readonly tools: AgentHandoffToolsByCapability;
  readonly names: readonly AgentHandoffToolName[];
}

export interface CreateAgentHandoffToolsOptions {
  /** The session/socket/attempt-scoped runtime accumulator. */
  readonly builder: AgentHandoffBuilder;
  /** Host boundary that routes the committed output through normal socket commit semantics. */
  readonly onCommit?: (commit: AgentHandoffCommit) => void | Promise<void>;
}

/**
 * Build a capability-scoped set of small handoff tools around one active builder.
 *
 * Unsupported setters are omitted entirely, rather than exposed with a schema
 * that can only fail. The model submits one work item or event at a time and
 * runtime code owns assembly, validation, and JSON serialization.
 */
export function createAgentHandoffTools(options: CreateAgentHandoffToolsOptions): AgentHandoffToolSet {
  const { builder } = options;
  const capabilities = builder.capabilities;
  const definitions: ToolDefinition[] = [];
  const tools: { -readonly [Key in keyof AgentHandoffToolsByCapability]?: AgentHandoffToolsByCapability[Key] } = {};

  if (capabilities.workItems) {
    const beginWorkItems = defineTool({
      name: AGENT_HANDOFF_TOOL_NAMES.beginWorkItems,
      label: "Begin Materia Handoff Work Items",
      description: "Include an explicitly empty canonical workItems array. Adding a work item includes the array automatically.",
      parameters: BEGIN_AGENT_HANDOFF_WORK_ITEMS_PARAMETERS,
      executionMode: "sequential",
      async execute() {
        builder.beginWorkItems();
        return handoffToolResult(builder, "The handoff will include workItems.", "begin_work_items", "workItems");
      },
    });
    const addWorkItem = defineTool({
      name: AGENT_HANDOFF_TOOL_NAMES.addWorkItem,
      label: "Add Materia Handoff Work Item",
      description: "Append one canonical work item in final order. Pass quotes, newlines, backslashes, and Unicode as ordinary strings; runtime code serializes them.",
      parameters: ADD_AGENT_HANDOFF_WORK_ITEM_PARAMETERS,
      executionMode: "sequential",
      async execute(_toolCallId, params) {
        builder.addWorkItem(params);
        return handoffToolResult(builder, "Added one handoff work item.", "add_work_item", "workItems");
      },
    });
    tools.beginWorkItems = beginWorkItems;
    tools.addWorkItem = addWorkItem;
    definitions.push(beginWorkItems, addWorkItem);
  }

  if (capabilities.satisfied) {
    const setSatisfied = defineTool({
      name: AGENT_HANDOFF_TOOL_NAMES.setSatisfied,
      label: "Set Materia Handoff Satisfaction",
      description: "Set the canonical satisfied boolean used by this socket's satisfied/not_satisfied graph control.",
      parameters: SET_AGENT_HANDOFF_SATISFIED_PARAMETERS,
      executionMode: "sequential",
      async execute(_toolCallId, params) {
        builder.setSatisfied(params.satisfied);
        return handoffToolResult(builder, "Set handoff satisfaction.", "set_satisfied", "satisfied");
      },
    });
    tools.setSatisfied = setSatisfied;
    definitions.push(setSatisfied);
  }

  const setContext = defineTool({
    name: AGENT_HANDOFF_TOOL_NAMES.setContext,
    label: "Set Materia Handoff Context",
    description: "Set optional canonical explanatory context for downstream agents. Runtime code owns JSON string escaping.",
    parameters: SET_AGENT_HANDOFF_CONTEXT_PARAMETERS,
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      builder.setContext(params.context);
      return handoffToolResult(builder, "Set handoff context.", "set_context", "context");
    },
  });
  tools.setContext = setContext;
  definitions.push(setContext);

  if (capabilities.events) {
    const emitEvent = defineTool({
      name: AGENT_HANDOFF_TOOL_NAMES.emitEvent,
      label: "Emit Materia Handoff Event",
      description: "Append one optional event side-channel object. Call once per event in dispatch order; do not include runtime-enriched ids, timestamps, or sequence fields.",
      parameters: EMIT_AGENT_HANDOFF_EVENT_PARAMETERS,
      executionMode: "sequential",
      async execute(_toolCallId, params) {
        builder.addEvent(params);
        return handoffToolResult(builder, "Added one handoff event.", "emit_event", "event");
      },
    });
    tools.emitEvent = emitEvent;
    definitions.push(emitEvent);
  }

  const commit = defineTool({
    name: AGENT_HANDOFF_TOOL_NAMES.commit,
    label: "Commit Materia Handoff",
    description: "Validate and commit the accumulated canonical handoff. Call as the sole final tool call after submitting every applicable field.",
    promptSnippet: "Commit a runtime-serialized materia handoff without authoring a JSON envelope",
    promptGuidelines: capabilityGuidelines(capabilities),
    parameters: COMMIT_AGENT_HANDOFF_PARAMETERS,
    executionMode: "sequential",
    async execute() {
      const committed = await builder.commit(options.onCommit);
      const fields = Object.freeze(Object.keys(committed.output));
      return {
        content: [{
          type: "text" as const,
          text: `Committed canonical handoff fields: ${fields.join(", ") || "(none)"}.`,
        }],
        details: {
          action: "commit" as const,
          scope: cloneAgentHandoffBuilderScope(builder.scope),
          workItemCount: committed.envelope.workItems?.length ?? 0,
          eventCount: committed.output.event?.length ?? 0,
          committed: true,
          fields,
          jsonBytes: new TextEncoder().encode(committed.json).byteLength,
        } satisfies AgentHandoffToolDetails,
        terminate: true,
      };
    },
  });
  tools.commit = commit;
  definitions.push(commit);

  const frozenDefinitions = Object.freeze([...definitions]);
  return Object.freeze({
    builder,
    capabilities,
    definitions: frozenDefinitions,
    tools: Object.freeze(tools) as unknown as AgentHandoffToolsByCapability,
    names: Object.freeze(frozenDefinitions.map((tool) => tool.name as AgentHandoffToolName)),
  });
}

/**
 * Register and activate exactly this socket's generated definitions. Previously
 * registered materia handoff tools are removed from Pi's active set so a new
 * socket cannot call a stale unsupported setter.
 */
export function exposeAgentHandoffTools(
  pi: ExtensionAPI,
  options: CreateAgentHandoffToolsOptions,
): AgentHandoffToolSet {
  const toolSet = createAgentHandoffTools(options);
  for (const tool of toolSet.definitions) pi.registerTool(tool);
  const unrelated = pi.getActiveTools().filter((name) => !isAgentHandoffToolName(name));
  pi.setActiveTools([...new Set([...unrelated, ...toolSet.names])]);
  return toolSet;
}

/** Remove all materia handoff tools from the active set without affecting other tools. */
export function hideAgentHandoffTools(pi: Pick<ExtensionAPI, "getActiveTools" | "setActiveTools">): void {
  const active = pi.getActiveTools();
  const filtered = active.filter((name) => !isAgentHandoffToolName(name));
  if (filtered.length !== active.length) pi.setActiveTools(filtered);
}

export function isAgentHandoffToolName(name: string): name is AgentHandoffToolName {
  return (AGENT_HANDOFF_TOOL_NAME_LIST as readonly string[]).includes(name);
}

function capabilityGuidelines(capabilities: AgentHandoffCapabilities): string[] {
  const guidelines: string[] = [];
  if (capabilities.workItems) {
    guidelines.push(`Use ${AGENT_HANDOFF_TOOL_NAMES.addWorkItem} once per work item and preserve final item order.`);
    guidelines.push(`Use ${AGENT_HANDOFF_TOOL_NAMES.beginWorkItems} only when an explicitly empty workItems result is required.`);
  }
  if (capabilities.satisfied) {
    guidelines.push(`Use ${AGENT_HANDOFF_TOOL_NAMES.setSatisfied} to supply this socket's required graph-control result.`);
  }
  guidelines.push(`Use ${AGENT_HANDOFF_TOOL_NAMES.setContext} only for explanatory downstream handoff notes.`);
  if (capabilities.events) {
    guidelines.push(`Use ${AGENT_HANDOFF_TOOL_NAMES.emitEvent} once per optional event in dispatch order.`);
  }
  guidelines.push(`Call ${AGENT_HANDOFF_TOOL_NAMES.commit} as the sole final tool call after all applicable handoff values are submitted.`);
  return guidelines;
}

function handoffToolResult(
  builder: AgentHandoffBuilder,
  text: string,
  action: AgentHandoffToolDetails["action"],
  field: NonNullable<AgentHandoffToolDetails["field"]>,
) {
  const snapshot = builder.snapshot();
  return {
    content: [{ type: "text" as const, text }],
    details: {
      action,
      field,
      scope: cloneAgentHandoffBuilderScope(builder.scope),
      workItemCount: snapshot.workItems?.length ?? 0,
      eventCount: snapshot.event?.length ?? 0,
      committed: false,
    } satisfies AgentHandoffToolDetails,
  };
}
