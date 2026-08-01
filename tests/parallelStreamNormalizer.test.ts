import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";

const scriptPath = path.resolve("config", "utilities", "normalize-parallel-streams.mjs");

type NormalizerOutput = {
  workItems: unknown[];
  satisfied: boolean;
  context: string;
  state?: { parallelPlan?: { planId?: string; streams?: Array<Record<string, unknown>> } };
};

async function runNormalizer(input: unknown): Promise<NormalizerOutput> {
  const processHandle = Bun.spawn([process.execPath, scriptPath], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  processHandle.stdin.write(`${JSON.stringify(input)}\n`);
  processHandle.stdin.end();
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(processHandle.stdout).text(),
    new Response(processHandle.stderr).text(),
    processHandle.exited,
  ]);
  expect(exitCode, stderr).toBe(0);
  return JSON.parse(stdout) as NormalizerOutput;
}

describe("Normalize-Parallel-Streams shipped utility", () => {
  test("is registered as a shipped generator utility", async () => {
    const config = JSON.parse(await readFile(path.resolve("config", "default.json"), "utf8")) as {
      materia?: Record<string, Record<string, unknown>>;
    };
    expect(config.materia?.["Normalize-Parallel-Streams"]).toMatchObject({
      type: "utility",
      generator: true,
      parse: "json",
      script: { kind: "shippedUtility", name: "normalize-parallel-streams.mjs", runtime: "node" },
    });
  });

  test("normalizes ordered streams without rewriting workItems", async () => {
    const workItems = [
      { title: "feat: API", context: "Implement the API." },
      { title: "feat: UI", context: "Implement the UI." },
      { title: "test: API", context: "Test the API." },
    ];
    const input = {
      state: {
        workItems,
        parallelSchedule: {
          version: 1,
          streams: [
            { name: "api", workItemIndexes: [0, 2] },
            { name: "ui", workItemIndexes: [1] },
          ],
        },
      },
    };

    const output = await runNormalizer(input);
    expect(output.satisfied).toBe(true);
    expect(output.workItems).toEqual(workItems);
    expect(output.state?.parallelPlan?.streams).toEqual([
      { laneId: "lane-api", name: "api", streamIndex: 0, workItemIndexes: [0, 2] },
      { laneId: "lane-ui", name: "ui", streamIndex: 1, workItemIndexes: [1] },
    ]);
    expect(output.state?.parallelPlan?.planId).toMatch(/^parallel-plan-v1-[0-9a-f]{16}$/);
    expect(output).not.toHaveProperty("parallelSchedule");

    const repeated = await runNormalizer(input);
    expect(repeated).toEqual(output);
  });

  test("returns actionable feedback for malformed, duplicate, and missing assignments", async () => {
    const workItems = [
      { title: "feat: API", context: "Implement the API." },
      { title: "feat: UI", context: "Implement the UI." },
    ];

    const malformed = await runNormalizer({ state: { workItems, parallelSchedule: { version: 1, streams: "nope" } } });
    expect(malformed.satisfied).toBe(false);
    expect(malformed.context).toContain("streams must be an array");
    expect(malformed.state).toBeUndefined();

    const duplicate = await runNormalizer({ state: { workItems, parallelSchedule: { version: 1, streams: [
      { name: "api", workItemIndexes: [0] },
      { name: "ui", workItemIndexes: [0, 1] },
    ] } } });
    expect(duplicate.satisfied).toBe(false);
    expect(duplicate.context).toContain("assigned more than once");
    expect(duplicate.context).toContain("exactly once");

    const missing = await runNormalizer({ state: { workItems, parallelSchedule: { version: 1, streams: [
      { name: "api", workItemIndexes: [0] },
    ] } } });
    expect(missing.satisfied).toBe(false);
    expect(missing.context).toContain("missing work-item index 1");
  });

  test("handles an empty plan as a deterministic no-op", async () => {
    const output = await runNormalizer({ state: { workItems: [], parallelSchedule: { version: 1, streams: [] } } });
    expect(output).toMatchObject({
      workItems: [],
      satisfied: true,
      state: { parallelPlan: { version: 1, workItemCount: 0, streams: [] } },
    });
    expect(output.context).toContain("no work items");
  });
});
