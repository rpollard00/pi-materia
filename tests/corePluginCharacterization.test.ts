import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import piMateria from "../src/index.js";
import { loadActiveCastState, listLatestCastStates } from "../src/native.js";
import { FakePiHarness } from "./fakePi.js";

async function makeCoreHarness(config: unknown): Promise<FakePiHarness> {
  process.env.PI_MATERIA_PROFILE_DIR = await mkdtemp(path.join(tmpdir(), "pi-materia-core-profile-"));
  const cwd = await mkdtemp(path.join(tmpdir(), "pi-materia-core-"));
  await mkdir(path.join(cwd, ".pi"), { recursive: true });
  await writeFile(path.join(cwd, ".pi", "pi-materia.json"), JSON.stringify(config, null, 2));
  const harness = new FakePiHarness(cwd);
  piMateria(harness.pi);
  return harness;
}

function promptMessages(harness: FakePiHarness): string[] {
  return harness.sentMessages
    .map(({ message }) => message as { customType?: string; content?: unknown })
    .filter((message) => message.customType === "pi-materia-prompt")
    .map((message) => String(message.content));
}

describe("core plugin characterization", () => {
  test.serial("loads the active loadout, starts a cast, assembles prompt context, and writes cast artifacts", async () => {
    const harness = await makeCoreHarness({
      artifactDir: ".pi/pi-materia-test-artifacts",
      activeLoadout: "Characterize",
      loadouts: {
        Characterize: {
          entry: "Socket-1",
          sockets: {
            "Socket-1": { type: "agent", materia: "Build", parse: "text", edges: [{ when: "always", to: "end" }] },
          },
        },
      },
      materia: {
        Build: { tools: "readOnly", prompt: "Build {{request}} with {{state.summary}}." },
      },
    });

    await harness.runCommand("materia", "cast preserve observable startup");

    const state = loadActiveCastState(harness.ctx);
    expect(state).toBeDefined();
    expect(state?.active).toBe(true);
    expect(state?.request).toBe("preserve observable startup");
    expect(state?.currentSocketId).toBe("Socket-1");
    expect(state?.currentMateria).toBe("Build");
    expect(state?.awaitingResponse).toBe(true);
    expect(state?.artifactRoot).toBe(path.join(harness.cwd, ".pi/pi-materia-test-artifacts"));
    expect(state?.runDir.startsWith(state.artifactRoot)).toBe(true);

    const prompt = promptMessages(harness).at(-1) ?? "";
    expect(prompt).toContain("Build preserve observable startup");
    expect(prompt).toContain("Socket adapter context");
    expect(prompt).toContain("Current workItem JSON: null");
    expect(prompt).toContain("Global guidance JSON: {}");
    expect(harness.operationLog).toContain("triggerTurn");

    expect(existsSync(path.join(state!.runDir, "config.resolved.json"))).toBe(true);
    expect(existsSync(path.join(state!.runDir, "manifest.json"))).toBe(true);
    expect(existsSync(path.join(state!.runDir, "usage.json"))).toBe(true);
    const contextFiles = await readdir(path.join(state!.runDir, "contexts"));
    expect(contextFiles).toHaveLength(1);
    const contextArtifact = await readFile(path.join(state!.runDir, "contexts", contextFiles[0]), "utf8");
    expect(contextArtifact).toContain("# Materia Isolated Context");
    expect(contextArtifact).toContain("Artifact directory:");
    expect(contextArtifact).toContain("## Hidden materia prompt");
    expect(contextArtifact).toContain("Build preserve observable startup");
  });

  test.serial("advances through JSON handoff routing while preserving canonical envelope fields", async () => {
    const harness = await makeCoreHarness({
      artifactDir: ".pi/pi-materia-test-artifacts",
      activeLoadout: "Characterize",
      loadouts: {
        Characterize: {
          entry: "Socket-1",
          sockets: {
            "Socket-1": {
              type: "agent",
              materia: "Plan",
              parse: "json",
              assign: { routedSummary: "$.summary", copiedFeedback: "$.feedback" },
              edges: [{ when: "satisfied", to: "Socket-2" }, { when: "not_satisfied", to: "end" }],
            },
            "Socket-2": { type: "agent", materia: "Build", parse: "text", foreach: { items: "state.workItems", as: "workItem", cursor: "workItemIndex", done: "end" } },
          },
        },
      },
      materia: {
        Plan: { tools: "readOnly", prompt: "Plan JSON." },
        Build: { tools: "readOnly", prompt: "Build {{item.id}} using {{state.summary}}." },
      },
    });

    await harness.runCommand("materia", "cast route one item");
    expect(loadActiveCastState(harness.ctx)?.currentSocketId).toBe("Socket-1");
    harness.appendAssistantMessage(JSON.stringify({
      summary: "one item planned",
      workItems: [{ id: "wi-1", title: "One", description: "Do one", acceptance: ["done"], context: { architecture: "thin adapters", constraints: [], dependencies: [], risks: [] } }],
      guidance: { scope: "core only" },
      decisions: ["keep webui contract"],
      risks: ["regression"],
      satisfied: true,
      feedback: "ready to build",
      missing: [],
      localDiagnostic: "not an envelope field",
    }));

    await harness.emit("agent_end", { messages: [] });

    const state = loadActiveCastState(harness.ctx);
    expect(state?.active).toBe(true);
    expect(state?.currentSocketId).toBe("Socket-2");
    expect(state?.currentItemKey).toBe("wi-1");
    expect(state?.data.summary).toBe("one item planned");
    expect(state?.data.workItems).toEqual([{ id: "wi-1", title: "One", description: "Do one", acceptance: ["done"], context: { architecture: "thin adapters", constraints: [], dependencies: [], risks: [] } }]);
    expect(state?.data.guidance).toEqual({ scope: "core only" });
    expect(state?.data.decisions).toEqual(["keep webui contract"]);
    expect(state?.data.risks).toEqual(["regression"]);
    expect(state?.data.routedSummary).toBe("one item planned");
    expect(state?.data.copiedFeedback).toBe("ready to build");
    expect(state?.data).not.toHaveProperty("feedback");
    expect(state?.data).not.toHaveProperty("missing");
    expect(state?.data.envelope).toMatchObject({ summary: "one item planned", satisfied: true, feedback: "ready to build", missing: [] });
    expect(state?.data.envelope).not.toHaveProperty("localDiagnostic");

    const buildPrompt = promptMessages(harness).at(-1) ?? "";
    expect(buildPrompt).toContain("Build wi-1 using one item planned.");
    expect(buildPrompt).toContain("Current workItem JSON");
    expect(buildPrompt).toContain('"id": "wi-1"');
    expect(buildPrompt).toContain("Global guidance JSON");
    expect(buildPrompt).toContain("core only");

    const jsonArtifact = JSON.parse(await readFile(path.join(state!.runDir, "sockets", "Socket-1", "1.json"), "utf8"));
    expect(jsonArtifact.workItems).toHaveLength(1);
    expect(jsonArtifact.satisfied).toBe(true);
    expect(jsonArtifact.feedback).toBe("ready to build");
  });

  test.serial("loads persisted cast states newest-first and returns the active state from session custom entries", async () => {
    const harness = await makeCoreHarness({ activeLoadout: "Unused", loadouts: { Unused: { entry: "Socket-1", sockets: { "Socket-1": { type: "agent", materia: "Build" } } } } });
    const base = {
      version: 1,
      request: "persisted request",
      configSource: "test",
      configHash: "hash",
      cwd: harness.cwd,
      runDir: path.join(harness.cwd, ".pi/pi-materia/cast"),
      artifactRoot: path.join(harness.cwd, ".pi/pi-materia"),
      phase: "Socket-1",
      currentSocketId: "Socket-1",
      currentMateria: "Build",
      awaitingResponse: false,
      socketState: "failed",
      startedAt: 1,
      updatedAt: 1,
      data: {},
      cursors: {},
      visits: {},
      multiTurnRefinements: {},
      taskAttempts: {},
      edgeTraversals: {},
      runState: { castId: "older", runDir: path.join(harness.cwd, ".pi/pi-materia/cast"), usage: { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, byMateria: {}, bySocket: {}, byTask: {}, byAttempt: {} } },
      pipeline: { entry: { id: "Socket-1", socket: { type: "agent", materia: "Build" }, materia: { tools: "readOnly", prompt: "" } }, sockets: {} },
    };

    harness.pi.appendEntry("pi-materia-cast-state", { ...base, active: false, castId: "older", failedReason: "first failed" });
    harness.pi.appendEntry("pi-materia-cast-state", { ...base, active: true, castId: "active", request: "active request", socketState: "awaiting_agent_response", awaitingResponse: true, runState: { ...base.runState, castId: "active" } });
    harness.pi.appendEntry("pi-materia-cast-state", { ...base, active: false, castId: "older", failedReason: "newest failed snapshot" });

    const latest = listLatestCastStates(harness.ctx);
    expect(latest.map((state) => state.castId)).toEqual(["older", "active"]);
    expect(latest[0].failedReason).toBe("newest failed snapshot");
    expect(loadActiveCastState(harness.ctx)?.castId).toBe("active");
  });
});
