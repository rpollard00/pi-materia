import { describe, expect, test } from "bun:test";
import { stripRenderableTextField } from "../src/application/handoffPromptSanitization.js";
import { formatHandoffJsonFinalInstruction } from "../src/handoff/handoffContract.js";
import { validateHandoffJsonOutput, handoffValidationIssues } from "../src/handoff/handoffValidation.js";
import { deriveSocketOutputRequirements } from "../src/handoff/socketOutputRequirements.js";

const plannerSocket = { parse: "json" as const };
const valid = {
  workItems: [
    { title: "feat: API", context: "Implement the API." },
    { title: "feat: UI", context: "Implement the UI." },
  ],
  parallelSchedule: {
    version: 1,
    streams: [
      { name: "api", workItemIndexes: [0] },
      { name: "ui", workItemIndexes: [1] },
    ],
  },
};

function plannerRequirements() {
  return deriveSocketOutputRequirements({
    socket: plannerSocket,
    socketId: "Planner",
    workItemsProducer: true,
    parallel: true,
  });
}

describe("parallel planner handoff sidecar", () => {
  test("requires and validates the versioned sidecar only for an opted-in planner", () => {
    const requirements = plannerRequirements();
    expect(requirements.parallelScheduleProducer).toBe(true);
    expect(requirements.requiredFields.map((field) => field.field)).toEqual(["workItems", "parallelSchedule"]);
    expect(validateHandoffJsonOutput(valid, { socketId: "Planner", requirements, agentOutput: true })).toBe(valid);
    expect(formatHandoffJsonFinalInstruction(requirements)).toContain("parallelSchedule");
  });

  test("rejects a sidecar emitted by an ordinary generator", () => {
    const requirements = deriveSocketOutputRequirements({ socket: plannerSocket, socketId: "Generator", workItemsProducer: true });
    let caught: unknown;
    try {
      validateHandoffJsonOutput({ workItems: valid.workItems, parallelSchedule: valid.parallelSchedule }, { socketId: "Generator", requirements, agentOutput: true });
    } catch (error) {
      caught = error;
    }
    expect(handoffValidationIssues(caught)?.some((issue) => issue.path === "$.parallelSchedule")).toBe(true);
  });

  test("rejects duplicate, missing, and unsupported stream indexes", () => {
    const requirements = plannerRequirements();
    expect(() => validateHandoffJsonOutput({
      ...valid,
      parallelSchedule: { version: 2, streams: [{ name: "all", workItemIndexes: [0, 0, 4] }] },
    }, { socketId: "Planner", requirements, agentOutput: true })).toThrow(/parallelSchedule/);
    expect(() => validateHandoffJsonOutput({
      workItems: valid.workItems,
      parallelSchedule: { version: 1, streams: [{ name: "only", workItemIndexes: [0] }] },
    }, { socketId: "Planner", requirements, agentOutput: true })).toThrow(/not assigned/);
  });

  test("strips the orchestration sidecar from automatic downstream context", () => {
    expect(stripRenderableTextField(valid)).toBe(JSON.stringify({ workItems: valid.workItems }));
  });
});
