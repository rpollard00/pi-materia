import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { createParallelRunState } from "../src/domain/parallelRun.js";
import piMateria from "../src/index.js";
import type { MateriaCastState } from "../src/types.js";
import { FakePiHarness } from "./fakePi.js";

async function makeHarness(): Promise<FakePiHarness> {
  const cwd = await mkdtemp(path.join(tmpdir(), "pi-materia-recovery-autocomplete-"));
  await mkdir(path.join(cwd, ".pi"), { recursive: true });
  await writeFile(path.join(cwd, ".pi", "pi-materia.json"), JSON.stringify({
    artifactDir: ".pi/pi-materia",
    activeLoadout: "Test",
    loadouts: { Test: { entry: "Socket-1", sockets: { "Socket-1": { materia: "Build" } } } },
    materia: { Build: { tools: "coding", prompt: "Build materia" } },
  }));
  const harness = new FakePiHarness(cwd);
  piMateria(harness.pi);
  await harness.emit("session_start");
  return harness;
}

async function addFailedParallelParent(harness: FakePiHarness): Promise<MateriaCastState> {
  await harness.runCommand("materia", "cast parallel recovery autocomplete");
  const state = harness.appendedEntries.filter((entry) => entry.customType === "pi-materia-cast-state").at(-1)?.data as MateriaCastState;
  const run = createParallelRunState({
    parentCastId: state.castId,
    loopId: "parallelWork",
    runId: "parallel-run",
    planIdentity: { version: 1, planId: "plan", workItemCount: 3 },
    graphIdentity: { graphHash: "graph" },
    configIdentity: { configHash: "config", loopId: "parallelWork", maxConcurrency: 2 },
    queue: [
      { laneId: "lane-one", name: "accepted stream", streamIndex: 0, workItemIndexes: [0] },
      { laneId: "lane-two", name: "a very long stream name that should be bounded in a label", streamIndex: 1, workItemIndexes: [1] },
      { laneId: "lane-three", name: "interrupted stream", streamIndex: 2, workItemIndexes: [2] },
    ],
    now: 1,
  });
  run.phase = "failed";
  run.fanInPhase = "skipped";
  run.lanes["lane-one"]!.status = "accepted";
  run.lanes["lane-two"]!.status = "failed";
  run.lanes["lane-two"]!.attempt = 4;
  run.lanes["lane-three"]!.status = "interrupted";
  run.lanes["lane-three"]!.attempt = 2;
  const failed = {
    ...state,
    active: false,
    phase: "failed",
    socketState: "failed",
    awaitingResponse: false,
    parallelRuns: { parallelWork: run },
    updatedAt: Date.now(),
  } as MateriaCastState;
  harness.pi.appendEntry("pi-materia-cast-state", failed);
  return failed;
}

describe("/materia revive and recast lane autocomplete", () => {
  test("offers implicit stable lane numbers, filters accepted lanes, and bounds labels", async () => {
    const harness = await makeHarness();
    const parent = await addFailedParallelParent(harness);

    const completions = await harness.getCommandCompletions("materia", "revive ");
    expect(completions).not.toBeNull();
    const laneTwo = completions!.find((completion) => completion.value === "revive 2")!;
    const laneThree = completions!.find((completion) => completion.value === "revive 3")!;
    expect(completions!.map((completion) => completion.value)).toContain(`revive ${parent.castId}`);
    expect(completions!.map((completion) => completion.value)).not.toContain("revive 1");
    expect(laneTwo.label).toContain("#2");
    expect(laneTwo.label).toContain("failed");
    expect(laneTwo.label).toContain("attempt 4");
    expect(laneTwo.label).not.toContain("should be bounded in a label");
    expect(laneThree.label).toContain("#3");
    expect(laneThree.label).toContain("interrupted");

    expect((await harness.getCommandCompletions("materia", "revive 2"))?.map((completion) => completion.value)).toEqual(["revive 2"]);
  });

  test("offers lanes after an explicit cast id and retains cast-id prefix filtering", async () => {
    const harness = await makeHarness();
    const parent = await addFailedParallelParent(harness);

    const castPrefix = await harness.getCommandCompletions("materia", "recast ");
    expect(castPrefix?.[0]?.value).toBe(`recast ${parent.castId}`);

    const explicit = await harness.getCommandCompletions("materia", `recast ${parent.castId} `);
    expect(explicit?.map((completion) => completion.value)).toEqual([
      `recast ${parent.castId} 2`,
      `recast ${parent.castId} 3`,
    ]);
    expect((await harness.getCommandCompletions("materia", `recast ${parent.castId} 3`))?.map((completion) => completion.value)).toEqual([
      `recast ${parent.castId} 3`,
    ]);
    expect((await harness.getCommandCompletions("materia", `recast ${parent.castId.slice(0, 8)}`))?.map((completion) => completion.value)).toEqual([
      `recast ${parent.castId}`,
    ]);
  });
});
