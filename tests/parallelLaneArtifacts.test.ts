import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { createParallelLaneArtifactStore } from "../src/infrastructure/index.js";

const usage = {
  tokens: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3 },
  cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 },
};

function identity(root: string) {
  return {
    parentCastId: "parent-1",
    runId: "run-1",
    loopId: "build",
    laneId: "lane-a",
    childCastId: "child-1",
    planId: "plan-1",
    graphHash: "graph-1",
    branchId: "branch-1",
    executionScopeId: "scope-1",
    attempt: 2,
    streamIndex: 0,
    workItemIndexes: [0, 1],
    coordinatorArtifactRoot: path.join(root, "attempt-2"),
    paths: {
      sessionPath: path.join(root, "attempt-2", "session.jsonl"),
      artifactRoot: path.join(root, "attempt-2", "artifacts"),
      runDirectory: path.join(root, "attempt-2", "run"),
    },
  };
}

describe("parallel lane artifact store", () => {
  test("keeps stable lane paths, ordered event streams, terminal metadata, and bounded diagnostics", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "materia-lane-"));
    const store = createParallelLaneArtifactStore();
    const input = identity(root);
    const paths = await store.initialize(input);

    await Promise.all([
      store.appendEvent({ ...input, event: { provenance: { childSequence: 1 }, event: { childCastId: "child-1", sequence: 1, type: "first", occurredAt: 1 } } }),
      store.appendEvent({ ...input, event: { provenance: { childSequence: 2 }, event: { childCastId: "child-1", sequence: 2, type: "second", occurredAt: 2 } } }),
    ]);
    await store.writeUsage({ ...input, usage });
    await store.writeTerminalResult({ ...input, result: { status: "succeeded", accepted: true, endedAt: 3 }, usage });
    await store.writeDiagnostics({
      ...input,
      diagnostics: Array.from({ length: 30 }, (_, index) => ({ code: `diagnostic-${index}`, message: "x".repeat(2_000), severity: "warning" as const, occurredAt: index })),
    });

    expect(paths.launchSpecPath).toContain(path.join("attempt-2", "run", "child-launch-attempt-2.json"));
    expect(JSON.parse(await readFile(paths.laneManifestPath, "utf8")).paths.eventStreamPath).toBe(paths.eventStreamPath);
    const events = (await readFile(paths.eventStreamPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(events.map((event) => event.event.sequence)).toEqual([1, 2]);
    expect(JSON.parse(await readFile(paths.terminalResultPath, "utf8"))).toMatchObject({ result: { accepted: true }, usage });
    const diagnostics = JSON.parse(await readFile(paths.diagnosticsPath, "utf8"));
    expect(diagnostics.diagnostics).toHaveLength(24);
    expect(diagnostics.diagnostics.every((entry: { message: string }) => entry.message.length <= 1_000)).toBe(true);
    expect(JSON.parse(await readFile(paths.usagePath, "utf8"))).toMatchObject({ usage });
  });
});
