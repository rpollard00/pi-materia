import { Type, type Static } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  ToolBackedHandoffSubmission,
  type ToolBackedHandoffCommit,
  type ToolBackedHandoffSubmissionOptions,
} from "./toolBackedHandoffSubmission.js";

export const TOOL_BACKED_HANDOFF_NAMES = {
  beginWorkItems: "materia_handoff_begin_work_items",
  addWorkItem: "materia_handoff_add_work_item",
  setSatisfied: "materia_handoff_set_satisfied",
  setContext: "materia_handoff_set_context",
  setText: "materia_handoff_set_text",
  commit: "materia_handoff_commit",
} as const;

export const BEGIN_WORK_ITEMS_PARAMETERS = Type.Object({}, { additionalProperties: false });
export const ADD_WORK_ITEM_PARAMETERS = Type.Object({
  title: Type.String({ minLength: 1, description: "Work item title" }),
  context: Type.String({ minLength: 1, description: "All item-specific implementation guidance" }),
}, { additionalProperties: false });
export const SET_SATISFIED_PARAMETERS = Type.Object({
  satisfied: Type.Boolean({ description: "Canonical graph-control result" }),
}, { additionalProperties: false });
export const SET_CONTEXT_PARAMETERS = Type.Object({
  context: Type.String({ description: "Explanatory handoff text for downstream agents" }),
}, { additionalProperties: false });
export const SET_TEXT_PARAMETERS = Type.Object({
  text: Type.String({ description: "Primary renderable prose for a text-enabled socket" }),
}, { additionalProperties: false });
export const COMMIT_HANDOFF_PARAMETERS = Type.Object({}, { additionalProperties: false });

export type AddWorkItemToolInput = Static<typeof ADD_WORK_ITEM_PARAMETERS>;
export type SetSatisfiedToolInput = Static<typeof SET_SATISFIED_PARAMETERS>;
export type SetContextToolInput = Static<typeof SET_CONTEXT_PARAMETERS>;
export type SetTextToolInput = Static<typeof SET_TEXT_PARAMETERS>;

export interface ToolBackedHandoffPrototypeOptions extends ToolBackedHandoffSubmissionOptions {
  /** Receives the runtime-serialized value when the terminating commit tool succeeds. */
  onCommit?: (commit: ToolBackedHandoffCommit) => void | Promise<void>;
}

interface PrototypeToolDetails {
  action: "begin_work_items" | "add_work_item" | "set_satisfied" | "set_context" | "set_text" | "commit";
  field?: "workItems" | "satisfied" | "context" | "text";
  workItemCount: number;
  committed: boolean;
  fields?: string[];
  jsonBytes?: number;
}

/**
 * Creates but does not globally enable the isolated handoff tool prototype.
 * Call {@link registerToolBackedHandoffPrototype} from an extension to expose
 * the definitions to an agent.
 */
export function createToolBackedHandoffPrototype(options: ToolBackedHandoffPrototypeOptions = {}) {
  const submission = new ToolBackedHandoffSubmission(options);

  const beginWorkItems = defineTool({
    name: TOOL_BACKED_HANDOFF_NAMES.beginWorkItems,
    label: "Begin Handoff Work Items",
    description: "Include the canonical workItems array in the handoff. Call this when an empty workItems array is a valid result; adding an item includes the array automatically.",
    parameters: BEGIN_WORK_ITEMS_PARAMETERS,
    executionMode: "sequential",
    async execute() {
      submission.beginWorkItems();
      return prototypeResult("The handoff will include workItems.", {
        action: "begin_work_items",
        field: "workItems",
        workItemCount: currentWorkItemCount(submission),
        committed: false,
      });
    },
  });

  const addWorkItem = defineTool({
    name: TOOL_BACKED_HANDOFF_NAMES.addWorkItem,
    label: "Add Handoff Work Item",
    description: "Append one canonical work item. Call once per item, in final order. Quotes, newlines, backslashes, and Unicode are plain string values; runtime code serializes them.",
    parameters: ADD_WORK_ITEM_PARAMETERS,
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      const count = submission.addWorkItem(params);
      return prototypeResult(`Added handoff work item ${count}.`, {
        action: "add_work_item",
        field: "workItems",
        workItemCount: count,
        committed: false,
      });
    },
  });

  const setSatisfied = defineTool({
    name: TOOL_BACKED_HANDOFF_NAMES.setSatisfied,
    label: "Set Handoff Satisfaction",
    description: "Set the canonical boolean satisfied field when the active socket uses satisfied/not_satisfied control flow.",
    parameters: SET_SATISFIED_PARAMETERS,
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      submission.setSatisfied(params.satisfied);
      return prototypeResult("Set handoff satisfied.", {
        action: "set_satisfied",
        field: "satisfied",
        workItemCount: currentWorkItemCount(submission),
        committed: false,
      });
    },
  });

  const setContext = defineTool({
    name: TOOL_BACKED_HANDOFF_NAMES.setContext,
    label: "Set Handoff Context",
    description: "Set canonical downstream explanatory context. Runtime code owns JSON string escaping.",
    parameters: SET_CONTEXT_PARAMETERS,
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      submission.setContext(params.context);
      return prototypeResult("Set handoff context.", {
        action: "set_context",
        field: "context",
        workItemCount: currentWorkItemCount(submission),
        committed: false,
      });
    },
  });

  const setText = defineTool({
    name: TOOL_BACKED_HANDOFF_NAMES.setText,
    label: "Set Handoff Text",
    description: "Set canonical renderable prose only for a text-enabled socket. Runtime code owns JSON string escaping.",
    parameters: SET_TEXT_PARAMETERS,
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      submission.setText(params.text);
      return prototypeResult("Set handoff text.", {
        action: "set_text",
        field: "text",
        workItemCount: currentWorkItemCount(submission),
        committed: false,
      });
    },
  });

  const commit = defineTool({
    name: TOOL_BACKED_HANDOFF_NAMES.commit,
    label: "Commit Handoff",
    description: "Validate and commit the accumulated canonical handoff. Call as the sole final tool call after all handoff fields have been submitted.",
    promptSnippet: "Commit a schema-validated materia handoff without model-authored envelope serialization",
    promptGuidelines: [
      `Use ${TOOL_BACKED_HANDOFF_NAMES.addWorkItem} once per work item and preserve final item order.`,
      `Use only handoff setter tools relevant to the active socket, then call ${TOOL_BACKED_HANDOFF_NAMES.commit} as the sole final tool call.`,
    ],
    parameters: COMMIT_HANDOFF_PARAMETERS,
    executionMode: "sequential",
    async execute() {
      const committed = await submission.commit(options.onCommit);
      const fields = Object.keys(committed.envelope);
      return {
        ...prototypeResult(`Committed canonical handoff fields: ${fields.join(", ") || "(none)"}.`, {
          action: "commit",
          workItemCount: committed.envelope.workItems?.length ?? 0,
          committed: true,
          fields,
          jsonBytes: new TextEncoder().encode(committed.json).byteLength,
        }),
        // Pi can skip the follow-up model turn when this is the only tool call
        // in its batch. See the prototype report for batching limitations.
        terminate: true,
      };
    },
  });

  return {
    submission,
    tools: {
      beginWorkItems,
      addWorkItem,
      setSatisfied,
      setContext,
      setText,
      commit,
    },
  };
}

export function registerToolBackedHandoffPrototype(
  pi: ExtensionAPI,
  options: ToolBackedHandoffPrototypeOptions = {},
) {
  const prototype = createToolBackedHandoffPrototype(options);
  pi.registerTool(prototype.tools.beginWorkItems);
  pi.registerTool(prototype.tools.addWorkItem);
  pi.registerTool(prototype.tools.setSatisfied);
  pi.registerTool(prototype.tools.setContext);
  pi.registerTool(prototype.tools.setText);
  pi.registerTool(prototype.tools.commit);
  return prototype;
}

function currentWorkItemCount(submission: ToolBackedHandoffSubmission): number {
  return submission.snapshot().workItems?.length ?? 0;
}

function prototypeResult(text: string, details: PrototypeToolDetails) {
  return {
    content: [{ type: "text" as const, text }],
    details,
  };
}
