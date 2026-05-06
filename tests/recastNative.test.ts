import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import piMateria from "../src/index.js";
import type { MateriaCastState } from "../src/types.js";
import { FakePiHarness } from "./fakePi.js";

async function makeHarness(): Promise<FakePiHarness> {
  const cwd = await mkdtemp(path.join(tmpdir(), "pi-materia-recast-"));
  await mkdir(path.join(cwd, ".pi"), { recursive: true });
  await writeFile(path.join(cwd, ".pi", "pi-materia.json"), JSON.stringify({
    artifactDir: ".pi/pi-materia",
    activeLoadout: "Test",
    loadouts: {
      Test: {
        entry: "work",
        nodes: {
          work: { type: "agent", materia: "Build" },
        },
      },
    },
    materia: { Build: { tools: "coding", prompt: "Build materia" } },
  }, null, 2));
  const harness = new FakePiHarness(cwd);
  piMateria(harness.pi);
  return harness;
}

function latestState(harness: FakePiHarness): MateriaCastState {
  const entry = harness.appendedEntries.filter((item) => item.customType === "pi-materia-cast-state").at(-1);
  if (!entry?.data) throw new Error("No materia cast state was appended");
  return entry.data as MateriaCastState;
}

function cloneState(state: MateriaCastState, overrides: Partial<MateriaCastState>): MateriaCastState {
  return { ...(structuredClone(state) as MateriaCastState), ...overrides, updatedAt: Date.now() };
}

async function failCurrentCast(harness: FakePiHarness, message = "provider outage"): Promise<MateriaCastState> {
  harness.appendAssistantMessage("", { stopReason: "error", errorMessage: message });
  await harness.emit("agent_end", { messages: [] });
  return latestState(harness);
}

describe("/materia recast", () => {
  test("without an explicit id resumes the newest failed or aborted cast", async () => {
    const harness = await makeHarness();

    await harness.runCommand("materia", "cast first task");
    const failed = await failCurrentCast(harness, "first failure");

    await harness.runCommand("materia", "cast second task");
    const secondRunning = latestState(harness);
    await harness.runCommand("materia", "abort");
    const aborted = latestState(harness);

    expect(aborted.castId).not.toBe(failed.castId);
    await harness.runCommand("materia", "recast");

    const resumed = latestState(harness);
    expect(resumed.castId).toBe(aborted.castId);
    expect(resumed.active).toBe(true);
    expect(resumed.nodeState).toBe("awaiting_agent_response");
    expect(resumed.runState.lastMessage).toBe("Recasting from node work.");
    expect(secondRunning.castId).toBe(aborted.castId);
  });

  test("explicit id resumes the requested failed cast", async () => {
    const harness = await makeHarness();

    await harness.runCommand("materia", "cast explicit task");
    const failed = await failCurrentCast(harness);

    await harness.runCommand("materia", `recast ${failed.castId}`);

    const resumed = latestState(harness);
    expect(resumed.castId).toBe(failed.castId);
    expect(resumed.active).toBe(true);
    expect(harness.notifications.at(-1)?.message).toContain(`pi-materia cast ${failed.castId} recast from node "work".`);
  });

  test("explicit id resumes an aborted cast", async () => {
    const harness = await makeHarness();

    await harness.runCommand("materia", "cast aborted task");
    await harness.runCommand("materia", "abort");
    const aborted = latestState(harness);

    await harness.runCommand("materia", `recast ${aborted.castId}`);

    const resumed = latestState(harness);
    expect(resumed.castId).toBe(aborted.castId);
    expect(resumed.active).toBe(true);
    expect(resumed.runState.lastMessage).toBe("Recasting from node work.");
  });

  test("reports clear errors for complete, running, missing, and non-resumable casts", async () => {
    const harness = await makeHarness();

    await harness.runCommand("materia", "cast complete task");
    harness.appendAssistantMessage("done");
    await harness.emit("agent_end", { messages: [] });
    const complete = latestState(harness);
    await harness.runCommand("materia", `recast ${complete.castId}`);
    expect(harness.notifications.at(-1)?.message).toContain("is complete and cannot be recast");

    await harness.runCommand("materia", "cast running task");
    const running = latestState(harness);
    await harness.runCommand("materia", `recast ${running.castId}`);
    expect(harness.notifications.at(-1)?.message).toContain("is already running");
    await harness.runCommand("materia", "abort");

    await harness.runCommand("materia", "recast missing-cast-id");
    expect(harness.notifications.at(-1)?.message).toContain('Unknown pi-materia cast id "missing-cast-id"');

    const aborted = latestState(harness);
    const idle = cloneState(aborted, { castId: "idle-cast", active: false, phase: "work", nodeState: "idle", failedReason: undefined });
    harness.pi.appendEntry("pi-materia-cast-state", idle);
    await harness.runCommand("materia", "recast idle-cast");
    expect(harness.notifications.at(-1)?.message).toContain("is not failed or aborted");
  });

  test("without an explicit id reports when no resumable casts exist", async () => {
    const harness = await makeHarness();

    await harness.runCommand("materia", "cast complete only");
    harness.appendAssistantMessage("done");
    await harness.emit("agent_end", { messages: [] });

    await harness.runCommand("materia", "recast");

    expect(harness.notifications.at(-1)).toEqual({
      message: "No failed or aborted pi-materia casts are available to recast.",
      type: "info",
    });
  });

  test("completions include only matching resumable casts newest first", async () => {
    const harness = await makeHarness();

    await harness.runCommand("materia", "cast older failed request");
    const older = await failCurrentCast(harness, "older failure");

    await harness.runCommand("materia", "cast complete request");
    harness.appendAssistantMessage("done");
    await harness.emit("agent_end", { messages: [] });
    const complete = latestState(harness);

    await harness.runCommand("materia", "cast newer aborted request");
    await harness.runCommand("materia", "abort");
    const newer = latestState(harness);

    const completions = harness.getCommandCompletions("materia", "recast ") ?? [];
    expect(completions.map((item) => item.value)).toEqual([`recast ${newer.castId}`, `recast ${older.castId}`]);
    expect(completions.map((item) => item.value)).not.toContain(`recast ${complete.castId}`);
    expect(completions[0].label).toContain("aborted");
    expect(completions[1].label).toContain("failed");
    expect(completions[0].description).toContain("newer aborted request");

    const prefixCompletions = harness.getCommandCompletions("materia", `recast ${older.castId.slice(0, -1)}`) ?? [];
    expect(prefixCompletions.map((item) => item.value)).toEqual([`recast ${older.castId}`]);
  });
});
