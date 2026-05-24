import { describe, expect, test } from "bun:test";
import { deriveSocketOutputRequirements } from "../src/handoff/socketOutputRequirements.js";
import type { MateriaPipelineSocketConfig } from "../src/types.js";

function socket(overrides: Partial<MateriaPipelineSocketConfig> = {}): MateriaPipelineSocketConfig {
  return { materia: "builder", parse: "json", ...overrides };
}

describe("socket output requirements", () => {
  test("non-JSON sockets produce no JSON-specific output requirements", () => {
    const requirements = deriveSocketOutputRequirements({ socket: socket({ parse: "text", edges: [{ when: "satisfied", to: "Socket-2" }] }), workItemsProducer: true });

    expect(requirements.parse).toBe("text");
    expect(requirements.requiresJsonObject).toBe(false);
    expect(requirements.requiredFields).toEqual([]);
    expect(requirements.consumedPayloadPaths).toEqual([]);
    expect(requirements.reservedFieldTypeRules).toEqual([]);
  });

  test("planner/generator JSON sockets require a top-level object and workItems", () => {
    const requirements = deriveSocketOutputRequirements({ socket: socket(), socketId: "Socket-1", workItemProducingSocketIds: new Set(["Socket-1"]) });

    expect(requirements.requiresJsonObject).toBe(true);
    expect(requirements.jsonObjectReason).toContain("parse mode is json");
    expect(requirements.requiredFields).toContainEqual({
      field: "workItems",
      path: "$.workItems",
      type: "array",
      reason: "Normalized graph semantics identify this socket as a workItems-producing generator/planner output.",
    });
    expect(requirements.requiredFields.map((field) => field.field)).not.toContain("satisfied");
  });

  test("evaluator/control sockets require satisfied only for satisfied routing", () => {
    const requirements = deriveSocketOutputRequirements({ socket: socket({ edges: [{ when: "not_satisfied", to: "Socket-2" }] }) });

    expect(requirements.requiredFields).toEqual([
      {
        field: "satisfied",
        path: "$.satisfied",
        type: "boolean",
        reason: "Current socket control flow uses satisfied/not_satisfied routing or advancement.",
      },
    ]);
    expect(requirements.reservedFieldTypeRules.find((rule) => rule.field === "satisfied")?.required).toBe(true);
    expect(requirements.reservedFieldTypeRules.map((rule) => rule.field)).not.toContain("feedback");
  });

  test("advance satisfied semantics require satisfied", () => {
    const requirements = deriveSocketOutputRequirements({ socket: socket({ advance: { cursor: "i", items: "state.workItems", when: "satisfied" } }) });

    expect(requirements.requiredFields.map((field) => field.field)).toEqual(["satisfied"]);
  });

  test("maintainer-like custom assigns are represented as consumed payload paths", () => {
    const requirements = deriveSocketOutputRequirements({
      socket: socket({
        assign: {
          checkpointCreated: "$.checkpointCreated",
          vcs: "$.vcs",
          commands: "$.commands",
        },
      }),
    });

    expect(requirements.requiredFields).toEqual([]);
    expect(requirements.consumedPayloadPaths).toEqual([
      { targetPath: "checkpointCreated", payloadPath: "$.checkpointCreated", topLevelField: "checkpointCreated", reason: "Socket assignment maps checkpointCreated from $.checkpointCreated." },
      { targetPath: "commands", payloadPath: "$.commands", topLevelField: "commands", reason: "Socket assignment maps commands from $.commands." },
      { targetPath: "vcs", payloadPath: "$.vcs", topLevelField: "vcs", reason: "Socket assignment maps vcs from $.vcs." },
    ]);
  });

  test("custom nested assigns preserve consumed nested payload paths", () => {
    const requirements = deriveSocketOutputRequirements({
      socket: socket({ assign: { "review.route": "$.review.route", "review.notes": "$.review.notes" } }),
    });

    expect(requirements.requiredFields).toEqual([]);
    expect(requirements.consumedPayloadPaths).toEqual([
      { targetPath: "review.notes", payloadPath: "$.review.notes", topLevelField: "review", reason: "Socket assignment maps review.notes from $.review.notes." },
      { targetPath: "review.route", payloadPath: "$.review.route", topLevelField: "review", reason: "Socket assignment maps review.route from $.review.route." },
    ]);
  });

  test("assigning runtime workItems from $.workItems requires top-level workItems array", () => {
    const requirements = deriveSocketOutputRequirements({ socket: socket({ assign: { workItems: "$.workItems" } }) });

    expect(requirements.requiredFields).toContainEqual({
      field: "workItems",
      path: "$.workItems",
      type: "array",
      reason: "Socket assignment maps runtime workItems from $.workItems.",
    });
    expect(requirements.consumedPayloadPaths).toContainEqual({
      targetPath: "workItems",
      payloadPath: "$.workItems",
      topLevelField: "workItems",
      reason: "Socket assignment maps workItems from $.workItems.",
    });
  });

  test("combined generator and control sockets require only consumed machine fields", () => {
    const requirements = deriveSocketOutputRequirements({
      socket: socket({
        edges: [{ when: "satisfied", to: "Socket-2" }],
        assign: { note: "$.diagnostics.note", decisions: "$.decisions" },
      }),
      socketId: "Socket-1",
      workItemProducingSocketIds: ["Socket-1"],
    });

    expect(requirements.requiredFields.map((field) => field.field)).toEqual(["satisfied", "workItems"]);
    expect(requirements.consumedPayloadPaths).toEqual([
      { targetPath: "decisions", payloadPath: "$.decisions", topLevelField: "decisions", reason: "Socket assignment maps decisions from $.decisions." },
      { targetPath: "note", payloadPath: "$.diagnostics.note", topLevelField: "diagnostics", reason: "Socket assignment maps note from $.diagnostics.note." },
    ]);
    expect(requirements.requiredFields.map((field) => field.field)).not.toEqual(expect.arrayContaining(["summary", "guidance", "risks", "feedback", "missing"]));
  });
});
