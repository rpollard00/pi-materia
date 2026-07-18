import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import piMateria from "../src/index.js";
import { validateHandoffJsonOutput } from "../src/handoff/handoffValidation.js";
import { parseSocketJson } from "../src/utilities/json.js";
import { FakePiHarness } from "./fakePi.js";

const fixtureRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "finalization");
const malformedFixtureNames = [
  "malformed-unescaped-quote.txt",
  "malformed-literal-newline.txt",
  "malformed-backslash.txt",
] as const;

async function fixtureText(name: string): Promise<string> {
  return readFile(path.join(fixtureRoot, name), "utf8");
}

async function complexEnvelope(): Promise<Record<string, unknown>> {
  return JSON.parse(await fixtureText("complex-canonical-envelope.json")) as Record<string, unknown>;
}

async function makeHarness(config: unknown): Promise<FakePiHarness> {
  const cwd = await mkdtemp(path.join(tmpdir(), "pi-materia-finalization-baseline-"));
  await mkdir(path.join(cwd, ".pi"), { recursive: true });
  await writeFile(path.join(cwd, ".pi", "pi-materia.json"), JSON.stringify(config, null, 2));
  const harness = new FakePiHarness(cwd);
  piMateria(harness.pi);
  return harness;
}

async function readEvents(harness: FakePiHarness): Promise<any[]> {
  const castRoot = path.join(harness.cwd, ".pi", "pi-materia");
  const castDir = path.join(castRoot, (await readdir(castRoot))[0]);
  const text = await readFile(path.join(castDir, "events.jsonl"), "utf8");
  return text.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

function latestCastState(harness: FakePiHarness): any {
  return harness.appendedEntries
    .filter((entry) => entry.customType === "pi-materia-cast-state")
    .at(-1)?.data as any;
}

function agentConfig() {
  return {
    artifactDir: ".pi/pi-materia",
    activeLoadout: "Baseline",
    loadouts: {
      Baseline: {
        entry: "Socket-1",
        sockets: {
          "Socket-1": {
            materia: "Agent-Finalizer",
            parse: "json",
            assign: { planned: "$.workItems", finalContext: "$.context" },
            edges: [{ when: "satisfied", to: "end" }],
          },
        },
      },
    },
    materia: {
      "Agent-Finalizer": { tools: "readOnly", prompt: "Return the canonical handoff." },
    },
  };
}

function utilityConfig(output: Record<string, unknown>) {
  return {
    artifactDir: ".pi/pi-materia",
    activeLoadout: "Baseline",
    loadouts: {
      Baseline: {
        entry: "Socket-1",
        sockets: {
          "Socket-1": {
            materia: "Utility-Finalizer",
            edges: [{ when: "satisfied", to: "end" }],
          },
        },
      },
    },
    materia: {
      "Utility-Finalizer": {
        type: "utility",
        utility: "echo",
        parse: "json",
        assign: { planned: "$.workItems", finalContext: "$.context" },
        params: { output },
      },
    },
  };
}

describe("agent finalization baseline", () => {
  test("round-trips quotes, newlines, backslashes, Unicode, and larger work-item contexts", async () => {
    const raw = await fixtureText("complex-canonical-envelope.json");
    const expected = await complexEnvelope();
    const workItems = expected.workItems as Array<{ title: string; context: string }>;

    expect(raw.length).toBeGreaterThan(4_500);
    expect(workItems).toHaveLength(10);
    expect(workItems[0].context).toContain('"npm test');
    expect(workItems[1].context).toContain("\n1. Parse");
    expect(workItems[2].context).toContain("C:\\Users\\materia");
    expect(workItems[2].context).toContain("\\n must not become");
    expect(workItems[3].context).toContain("東京");
    expect(workItems[3].context).toContain("🧪🚀");

    const parsed = parseSocketJson<Record<string, unknown>>("Socket-1", raw);
    expect(validateHandoffJsonOutput(parsed, {
      socketId: "Socket-1",
      socket: {
        materia: "Agent-Finalizer",
        parse: "json",
        assign: { planned: "$.workItems", finalContext: "$.context" },
        edges: [{ when: "satisfied", to: "end" }],
      },
      agentOutput: true,
    })).toEqual(expected);

    const harness = await makeHarness(agentConfig());
    await harness.runCommand("materia", "cast complex direct JSON baseline");
    harness.appendAssistantMessage(raw, {
      usage: { input: 100, output: 200, totalTokens: 300, cost: { total: 0.01 } },
    });
    await harness.emit("agent_end", { messages: [] });

    const state = latestCastState(harness);
    expect(state.active).toBe(false);
    expect(state.lastJson).toEqual(expected);
    expect(state.data.planned).toEqual(expected.workItems);
    expect(state.data.finalContext).toBe(expected.context);
    expect(harness.operationLog.filter((operation) => operation === "triggerTurn")).toHaveLength(1);
    const events = await readEvents(harness);
    expect(events.filter((event) => event.type.startsWith("same_socket_recovery"))).toHaveLength(0);
    expect(events.filter((event) => event.type === "socket_complete")).toHaveLength(1);
  });

  test("classifies malformed escaping fixtures as JSON parse failures and retries only the agent", async () => {
    for (const fixtureName of malformedFixtureNames) {
      const raw = await fixtureText(fixtureName);
      expect(() => JSON.parse(raw)).toThrow();

      const harness = await makeHarness(agentConfig());
      await harness.runCommand("materia", `cast malformed finalization baseline ${fixtureName}`);
      harness.appendAssistantMessage(raw);
      await harness.emit("agent_end", { messages: [] });

      let state = latestCastState(harness);
      expect(state.active).toBe(true);
      expect(state.awaitingResponse).toBe(true);
      expect(state.currentSocketId).toBe("Socket-1");
      expect(state.lastJson).toBeUndefined();
      expect(state.visits).toEqual({ "Socket-1": 1 });
      expect(harness.operationLog.filter((operation) => operation === "triggerTurn")).toHaveLength(2);

      let events = await readEvents(harness);
      const recovery = events.find((event) => event.type === "same_socket_recovery_start");
      expect(recovery?.data).toMatchObject({
        socket: "Socket-1",
        attempt: 1,
        recoveryKind: "json_output_repair",
        validationKind: "json_parse",
      });
      expect(events.filter((event) => event.type === "socket_complete")).toHaveLength(0);

      harness.appendAssistantMessage('{"workItems":[],"satisfied":true,"context":"corrected"}');
      await harness.emit("agent_end", { messages: [] });

      state = latestCastState(harness);
      expect(state.active).toBe(false);
      expect(state.data.finalContext).toBe("corrected");
      expect(state.visits).toEqual({ "Socket-1": 1 });
      events = await readEvents(harness);
      expect(events.filter((event) => event.type === "same_socket_recovery_retry")).toHaveLength(1);
      expect(events.filter((event) => event.type === "socket_complete")).toHaveLength(1);
    }
  });

  test("keeps deterministic utility serialization as a zero-agent-retry baseline", async () => {
    const output = await complexEnvelope();
    const harness = await makeHarness(utilityConfig(output));
    await harness.runCommand("materia", "cast deterministic utility baseline");

    const state = latestCastState(harness);
    expect(state.active).toBe(false);
    expect(state.lastJson).toEqual(output);
    expect(state.data.planned).toEqual(output.workItems);
    expect(state.data.finalContext).toBe(output.context);
    expect(harness.operationLog.filter((operation) => operation === "triggerTurn")).toHaveLength(0);

    const events = await readEvents(harness);
    expect(events.filter((event) => event.type === "utility_input")).toHaveLength(1);
    expect(events.filter((event) => event.type === "socket_complete")).toHaveLength(1);
    expect(events.filter((event) => event.type.startsWith("same_socket_recovery"))).toHaveLength(0);
  });

  test("captures the available model-run and deterministic utility measurements separately", async () => {
    const evidence = JSON.parse(await fixtureText("model-run-evidence.json")) as any;
    const agents = evidence.agentFinalizations as any[];
    const utilities = evidence.deterministicUtilityFinalizations as any[];

    expect(agents).toHaveLength(3);
    expect(utilities).toHaveLength(3);
    expect(agents.filter((run) => run.firstSubmissionOutcome === "rejected")).toHaveLength(1);
    expect(agents.filter((run) => run.eventualOutcome === "accepted")).toHaveLength(3);
    expect(agents.reduce((total, run) => total + run.jsonRepairRetries, 0)).toBe(1);
    expect(agents.reduce((total, run) => total + run.finalizationLatencyMs, 0) / agents.length).toBeCloseTo(167_502.33, 2);
    expect(agents.reduce((total, run) => total + run.reportedUsage.totalTokens, 0)).toBe(112_758);

    const observedRetry = agents.find((run) => run.jsonRepairRetries === 1);
    expect(observedRetry).toMatchObject({
      failureCategory: "json_parse_empty_output",
      retryLatencyMs: 83_414,
      retryReportedUsage: { totalTokens: 6_856, costKind: "subscription" },
    });

    expect(utilities.every((run) => run.retries === 0 && run.modelTokens === 0)).toBe(true);
    expect(utilities.reduce((total, run) => total + run.socketLatencyMs, 0) / utilities.length).toBeCloseTo(47.67, 2);
    expect(evidence.source.limitations.join(" ")).toContain("no smaller model");
    expect(evidence.source.limitations.join(" ")).toContain("no observed escaping-attributed");
  });
});
