import { describe, expect, test } from "bun:test";
import { normalizeParallelPlan } from "../src/handoff/parallelPlan.js";
import { readNormalizedParallelPlan } from "../src/runtime/parallelDispatchSupport.js";
import type { MateriaCastState } from "../src/types.js";

const workItems = [
  { title: "feat: API", context: "Implement the API." },
  { title: "feat: UI", context: "Implement the UI." },
  { title: "test: API", context: "Test the API." },
];

describe("intrinsic parallel plan normalization", () => {
  test("preserves authored ordering and creates stable lane and plan identities", () => {
    const schedule = {
      version: 1,
      streams: [
        { name: " API ", workItemIndexes: [2, 0] },
        { name: "api!", workItemIndexes: [1] },
      ],
    };
    const first = normalizeParallelPlan(workItems, schedule);
    const repeated = normalizeParallelPlan(workItems, schedule);

    expect(first).toEqual(repeated);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.planId).toMatch(/^parallel-plan-v1-[0-9a-f]{16}$/);
    expect(first.value.streams).toEqual([
      { laneId: "lane-api-c8e5998f", name: "API", streamIndex: 0, workItemIndexes: [2, 0] },
      { laneId: "lane-api-2a3ce982", name: "api!", streamIndex: 1, workItemIndexes: [1] },
    ]);
  });

  test("globally disambiguates colliding lane candidates into a runtime-consumable plan", () => {
    const result = normalizeParallelPlan(workItems, {
      version: 1,
      streams: [
        { name: "API", workItemIndexes: [0] },
        { name: "api!", workItemIndexes: [1] },
        { name: "api-c8e5998f", workItemIndexes: [2] },
      ],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.streams.map((stream) => stream.laneId)).toEqual([
      "lane-api-c8e5998f",
      "lane-api-2a3ce982",
      "lane-api-c8e5998f-3",
    ]);
    const state = { data: { parallelPlan: result.value } } as MateriaCastState;
    expect(readNormalizedParallelPlan(state, "state.parallelPlan")).toEqual(result.value);
  });

  test("validates version and exact coverage in the core normalizer", () => {
    const result = normalizeParallelPlan(workItems, {
      version: 2,
      streams: [{ name: "all", workItemIndexes: [0, 0] }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.message).join("\n")).toContain("supported version 1");
    expect(result.issues.map((issue) => issue.message).join("\n")).toContain("assigned more than once");
    expect(result.issues.map((issue) => issue.message).join("\n")).toContain("index 1 is not assigned");
  });

  test("creates a deterministic empty plan", () => {
    const result = normalizeParallelPlan([], { version: 1, streams: [] });
    expect(result).toEqual({
      ok: true,
      value: {
        version: 1,
        planId: "parallel-plan-v1-5b86e2c0603d9821",
        workItemCount: 0,
        streams: [],
      },
    });
  });
});
