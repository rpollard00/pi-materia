import { describe, expect, test } from "bun:test";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import piMateria from "../src/index.js";
import { AGENT_HANDOFF_TOOL_NAMES, isAgentHandoffToolName } from "../src/runtime/agentHandoffTools.js";
import type { MateriaCastState } from "../src/types.js";
import { FakePiHarness } from "./fakePi.js";

const canonicalEnvelope = {
  workItems: [
    {
      title: "feat: preserve \"quoted\" paths",
      context: "Run from C:\\repo\\materia.\nKeep literal \\n and regex ^foo\\s+bar$.",
    },
    {
      title: "test: preserve Unicode 東京 🧪",
      context: "Keep combining é, emoji 🚀, tabs\t, and UNC \\\\server\\share in order.",
    },
  ],
  satisfied: true,
  context: "Runtime context with \"quotes\", CRLF\r\nnext line, C:\\Users\\materia, and 東京.",
};

const sideChannelEvent = {
  type: "status.compatibility",
  severity: "warning",
  message: "Finalization \"event\"\nnext line",
  payload: { path: "C:\\repo", unicode: "東京 🧪" },
};

function outputWithEvent() {
  return {
    ...canonicalEnvelope,
    workItems: canonicalEnvelope.workItems.map((item) => ({ ...item })),
    event: [{ ...sideChannelEvent, payload: { ...sideChannelEvent.payload } }],
  };
}

interface AgentHarnessOptions {
  strategy?: "direct_json" | "tool_backed";
  provider?: string;
  qualifiedProvider?: string;
}

async function makeAgentHarness(options: AgentHarnessOptions = {}): Promise<FakePiHarness> {
  const cwd = await mkdtemp(path.join(tmpdir(), "pi-materia-finalization-compatibility-agent-"));
  await mkdir(path.join(cwd, ".pi"), { recursive: true });
  const provider = options.provider ?? "test";
  await writeFile(path.join(cwd, ".pi", "pi-materia.json"), JSON.stringify({
    artifactDir: ".pi/pi-materia",
    activeLoadout: "Compatibility",
    ...(options.strategy ? {
      finalization: {
        agentJson: {
          strategy: options.strategy,
          qualifiedModels: [{
            provider: options.qualifiedProvider ?? "test",
            model: "small",
            api: "fake",
            socketIds: ["Socket-1"],
          }],
        },
      },
    } : {}),
    loadouts: {
      Compatibility: {
        entry: "Socket-1",
        sockets: {
          "Socket-1": {
            materia: "Plan",
            parse: "json",
            assign: { workItems: "$.workItems", finalContext: "$.context" },
            edges: [{ when: "satisfied", to: "end" }],
          },
        },
      },
    },
    materia: {
      Plan: {
        type: "agent",
        tools: "readOnly",
        prompt: "Return the compatibility handoff.",
        model: `${provider}/small`,
      },
    },
  }, null, 2));

  const harness = new FakePiHarness(cwd);
  harness.models = [{ provider, id: "small", name: "Small", api: "fake" }];
  piMateria(harness.pi);
  return harness;
}

async function makeUtilityHarness(output: Record<string, unknown>): Promise<FakePiHarness> {
  const cwd = await mkdtemp(path.join(tmpdir(), "pi-materia-finalization-compatibility-utility-"));
  await mkdir(path.join(cwd, ".pi"), { recursive: true });
  await writeFile(path.join(cwd, ".pi", "pi-materia.json"), JSON.stringify({
    artifactDir: ".pi/pi-materia",
    activeLoadout: "Compatibility",
    finalization: {
      agentJson: {
        strategy: "tool_backed",
        qualifiedModels: [{ provider: "*", model: "*" }],
      },
    },
    loadouts: {
      Compatibility: {
        entry: "Socket-1",
        sockets: {
          "Socket-1": {
            materia: "Utility",
            edges: [{ when: "satisfied", to: "end" }],
          },
        },
      },
    },
    materia: {
      Utility: {
        type: "utility",
        utility: "echo",
        parse: "json",
        assign: { workItems: "$.workItems", finalContext: "$.context" },
        params: { output },
      },
    },
  }, null, 2));

  const harness = new FakePiHarness(cwd);
  piMateria(harness.pi);
  return harness;
}

async function invoke(harness: FakePiHarness, name: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const tool = harness.registeredTools.get(name) as ToolDefinition | undefined;
  if (!tool) throw new Error(`Tool not registered: ${name}`);
  return tool.execute(`call-${name}`, args, undefined, undefined, harness.ctx);
}

function latestState(harness: FakePiHarness): MateriaCastState {
  const state = harness.appendedEntries
    .filter((entry) => entry.customType === "pi-materia-cast-state")
    .at(-1)?.data as MateriaCastState | undefined;
  if (!state) throw new Error("No cast state recorded");
  return state;
}

async function submitDirect(harness: FakePiHarness): Promise<MateriaCastState> {
  harness.appendAssistantMessage(JSON.stringify(outputWithEvent()));
  await harness.emit("agent_end", { messages: [] });
  return latestState(harness);
}

async function submitWithTools(harness: FakePiHarness): Promise<MateriaCastState> {
  for (const item of canonicalEnvelope.workItems) {
    await invoke(harness, AGENT_HANDOFF_TOOL_NAMES.addWorkItem, item);
  }
  await invoke(harness, AGENT_HANDOFF_TOOL_NAMES.setSatisfied, { satisfied: canonicalEnvelope.satisfied });
  await invoke(harness, AGENT_HANDOFF_TOOL_NAMES.setContext, { context: canonicalEnvelope.context });
  await invoke(harness, AGENT_HANDOFF_TOOL_NAMES.emitEvent, sideChannelEvent);
  await invoke(harness, AGENT_HANDOFF_TOOL_NAMES.commit);
  harness.appendAssistantMessage("");
  await harness.emit("agent_end", { messages: [] });
  return latestState(harness);
}

describe("finalization strategy compatibility", () => {
  test("all successful agent, fallback, and deterministic utility paths produce the same canonical runtime envelope", async () => {
    const directHarness = await makeAgentHarness();
    await directHarness.runCommand("materia", "cast direct compatibility");
    expect(latestState(directHarness).agentFinalization).toMatchObject({
      strategy: "direct_json",
      reason: "default_direct_json",
    });
    const direct = await submitDirect(directHarness);

    const toolHarness = await makeAgentHarness({ strategy: "tool_backed" });
    await toolHarness.runCommand("materia", "cast tool compatibility");
    expect(latestState(toolHarness).agentFinalization).toMatchObject({
      strategy: "tool_backed",
      reason: "qualified_tool_model",
    });
    const toolBacked = await submitWithTools(toolHarness);

    const providerFallbackHarness = await makeAgentHarness({
      strategy: "tool_backed",
      provider: "alternate",
      qualifiedProvider: "test",
    });
    await providerFallbackHarness.runCommand("materia", "cast provider fallback compatibility");
    expect(latestState(providerFallbackHarness).agentFinalization).toMatchObject({
      strategy: "direct_json",
      configuredStrategy: "tool_backed",
      reason: "unqualified_model",
    });
    expect(providerFallbackHarness.activeTools.some(isAgentHandoffToolName)).toBe(false);
    const providerFallback = await submitDirect(providerFallbackHarness);

    const retryHarness = await makeAgentHarness({ strategy: "tool_backed" });
    await retryHarness.runCommand("materia", "cast missing commit retry compatibility");
    await invoke(retryHarness, AGENT_HANDOFF_TOOL_NAMES.addWorkItem, {
      title: "fix: discarded partial item",
      context: "This uncommitted value must not leak into the retry.",
    });
    retryHarness.appendAssistantMessage('{"workItems":[]}');
    await retryHarness.emit("agent_end", { messages: [] });
    expect(latestState(retryHarness).agentFinalization).toMatchObject({
      strategy: "direct_json",
      reason: "direct_json_fallback",
      phase: "fallback",
    });
    const retryFallback = await submitDirect(retryHarness);

    const deterministicOutput = outputWithEvent();
    const utilityHarness = await makeUtilityHarness(deterministicOutput);
    await utilityHarness.runCommand("materia", "cast deterministic utility compatibility");
    const utility = latestState(utilityHarness);

    for (const state of [direct, toolBacked, providerFallback, retryFallback, utility]) {
      expect(state.active).toBe(false);
      expect(state.lastJson).toEqual(canonicalEnvelope);
      expect(state.data.workItems).toEqual(canonicalEnvelope.workItems);
      expect(state.data.finalContext).toBe(canonicalEnvelope.context);
      expect(state.lastJson).not.toHaveProperty("event");
    }
    expect(new Set([direct, toolBacked, providerFallback, retryFallback, utility]
      .map((state) => JSON.stringify(state.lastJson))).size).toBe(1);

    expect(deterministicOutput).toEqual(outputWithEvent());
    expect(utilityHarness.operationLog.filter((operation) => operation === "triggerTurn")).toHaveLength(0);
    expect(utilityHarness.activeTools.some(isAgentHandoffToolName)).toBe(false);
  });
});
