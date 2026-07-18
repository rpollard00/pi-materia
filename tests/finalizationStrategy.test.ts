import { describe, expect, test } from "bun:test";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildSocketPrompt } from "../src/application/promptAssembly.js";
import { AGENT_HANDOFF_TOOL_NAMES, isAgentHandoffToolName } from "../src/runtime/agentHandoffTools.js";
import { selectAgentFinalizationStrategy } from "../src/runtime/finalizationStrategy.js";
import piMateria from "../src/index.js";
import type { MateriaCastState, ResolvedMateriaSocket } from "../src/types.js";
import { FakePiHarness } from "./fakePi.js";

const jsonAgent = {
  id: "Socket-1",
  socket: { materia: "Plan", parse: "json" as const, assign: { workItems: "$.workItems" } },
  materia: { type: "agent" as const, tools: "readOnly" as const, prompt: "Plan" },
} satisfies ResolvedMateriaSocket;

const utility = {
  id: "Socket-U",
  socket: { materia: "Utility", parse: "json" as const },
  materiaId: "Utility",
  materia: { type: "utility" as const, utility: "echo", parse: "json" as const },
} satisfies ResolvedMateriaSocket;

const effectiveModel = {
  model: "small",
  provider: "test",
  api: "fake",
  effectiveModel: "test/small",
  modelExplicit: true,
  thinkingExplicit: false,
  source: "configured" as const,
  label: "test/small",
};

function toolPolicy(qualification: Record<string, unknown> = {}) {
  return {
    finalization: {
      agentJson: {
        strategy: "tool_backed" as const,
        qualifiedModels: [{ model: "small", provider: "test", ...qualification }],
      },
    },
  };
}

describe("producer-capability finalization selection", () => {
  test("keeps direct JSON as the backward-compatible default", () => {
    expect(selectAgentFinalizationStrategy({ config: {}, socket: jsonAgent, model: effectiveModel })).toEqual({
      strategy: "direct_json",
      configuredStrategy: "direct_json",
      reason: "default_direct_json",
    });
  });

  test("activates tools only for an explicitly qualified, representable agent JSON socket", () => {
    expect(selectAgentFinalizationStrategy({
      config: toolPolicy(),
      socket: jsonAgent,
      model: effectiveModel,
      finalizationTurn: true,
    })).toEqual({
      strategy: "tool_backed",
      configuredStrategy: "tool_backed",
      reason: "qualified_tool_model",
    });

    expect(selectAgentFinalizationStrategy({
      config: toolPolicy(),
      socket: jsonAgent,
      model: { ...effectiveModel, model: "other", effectiveModel: "test/other" },
      finalizationTurn: true,
    }).reason).toBe("unqualified_model");

    const renderable = {
      ...jsonAgent,
      socket: { ...jsonAgent.socket, assign: { narration: "$.text" } },
    } satisfies ResolvedMateriaSocket;
    expect(selectAgentFinalizationStrategy({
      config: toolPolicy(),
      socket: renderable,
      model: effectiveModel,
      finalizationTurn: true,
    }).reason).toBe("unsupported_socket");
  });

  test("never routes deterministic utilities through agent tools", () => {
    expect(selectAgentFinalizationStrategy({
      config: toolPolicy({ model: "*" }),
      socket: utility,
      model: effectiveModel,
      finalizationTurn: true,
    })).toEqual({
      strategy: "direct_json",
      configuredStrategy: "tool_backed",
      reason: "deterministic_producer",
    });
  });

  test("honors optional socket and materia cohort restrictions", () => {
    expect(selectAgentFinalizationStrategy({
      config: toolPolicy({ socketIds: ["Other"] }),
      socket: jsonAgent,
      model: effectiveModel,
      finalizationTurn: true,
    }).reason).toBe("unqualified_model");
    expect(selectAgentFinalizationStrategy({
      config: toolPolicy({ materiaIds: ["Plan"] }),
      socket: jsonAgent,
      model: effectiveModel,
      finalizationTurn: true,
    }).strategy).toBe("tool_backed");
  });
});

describe("native tool-backed finalization routing", () => {
  test("commits runtime JSON through the normal socket boundary and makes tool commit authoritative over text", async () => {
    const harness = await makeHarness();
    await harness.runCommand("materia", "cast route a handoff");

    expect(harness.activeTools).toContain(AGENT_HANDOFF_TOOL_NAMES.commit);
    const initialState = latestState(harness);
    expect(initialState.agentFinalization).toMatchObject({
      strategy: "tool_backed",
      reason: "qualified_tool_model",
      phase: "active",
    });
    expect(latestPrompt(harness)).toContain("tool-backed materia handoff submission is active");
    expect(latestPrompt(harness)).not.toContain("Return only one top-level JSON object");

    await invoke(harness, AGENT_HANDOFF_TOOL_NAMES.addWorkItem, {
      title: "feat: preserve \"quotes\"",
      context: "Path C:\\repo\nUnicode 東京 and literal \\n.",
    });
    await invoke(harness, AGENT_HANDOFF_TOOL_NAMES.setContext, {
      context: "Runtime-owned \"context\"\nnext line",
    });
    await invoke(harness, AGENT_HANDOFF_TOOL_NAMES.emitEvent, {
      type: "status.progress",
      message: "tool event",
    });
    await invoke(harness, AGENT_HANDOFF_TOOL_NAMES.commit, {});

    harness.appendAssistantMessage('{"workItems":[]}');
    await harness.emit("agent_end", { messages: [] });

    const state = latestState(harness);
    expect(state.active).toBe(false);
    expect(state.lastJson).toEqual({
      workItems: [{
        title: "feat: preserve \"quotes\"",
        context: "Path C:\\repo\nUnicode 東京 and literal \\n.",
      }],
      context: "Runtime-owned \"context\"\nnext line",
    });
    expect(state.data.workItems).toEqual(state.lastJson.workItems);
    expect((state.lastJson as Record<string, unknown>).event).toBeUndefined();
    expect(state.lastAssistantText).toBe(JSON.stringify(state.lastJson));
    expect(harness.activeTools.some(isAgentHandoffToolName)).toBe(false);

    const events = await readRunEvents(state);
    expect(events.some((event) => event.type === "agent_finalization_protocol_conflict"
      && event.data.resolution === "tool_commit_authoritative_text_ignored"
      && event.data.ignoredTextBytes > 0)).toBe(true);
  });

  test("discards an uncommitted tool attempt and retries cleanly with direct JSON", async () => {
    const harness = await makeHarness();
    await harness.runCommand("materia", "cast fallback cleanly");

    await invoke(harness, AGENT_HANDOFF_TOOL_NAMES.addWorkItem, {
      title: "feat: partial tool value",
      context: "This value must not leak into fallback.",
    });
    harness.appendAssistantMessage('{"workItems":[{"title":"feat: textual conflict","context":"Do not accept this attempt."}]}');
    await harness.emit("agent_end", { messages: [] });

    const retry = latestState(harness);
    expect(retry.active).toBe(true);
    expect(retry.awaitingResponse).toBe(true);
    expect(retry.data.workItems).toBeUndefined();
    expect(retry.agentFinalization).toMatchObject({
      strategy: "direct_json",
      configuredStrategy: "tool_backed",
      reason: "direct_json_fallback",
      phase: "fallback",
      fallbackFrom: "tool_backed",
    });
    expect(harness.activeTools.some(isAgentHandoffToolName)).toBe(false);
    expect(latestPrompt(harness)).toContain("Return only one top-level JSON object");
    expect(latestPrompt(harness)).not.toContain("tool-backed materia handoff submission is active");
    expect(latestPrompt(harness)).not.toContain("textual conflict");

    const corrected = {
      workItems: [{ title: "feat: corrected direct value", context: "Accepted on the clean fallback attempt." }],
      context: "fallback accepted",
    };
    harness.appendAssistantMessage(JSON.stringify(corrected));
    await harness.emit("agent_end", { messages: [] });

    const completed = latestState(harness);
    expect(completed.active).toBe(false);
    expect(completed.lastJson).toEqual(corrected);
    expect(completed.data.workItems).toEqual(corrected.workItems);
  });

  test("uses direct JSON without exposing handoff tools when the effective model is unqualified", async () => {
    const harness = await makeHarness("other");
    await harness.runCommand("materia", "cast unsupported model fallback");

    const state = latestState(harness);
    expect(state.agentFinalization).toMatchObject({
      strategy: "direct_json",
      configuredStrategy: "tool_backed",
      reason: "unqualified_model",
    });
    expect(harness.activeTools.some(isAgentHandoffToolName)).toBe(false);
    expect(latestPrompt(harness)).toContain("Return only one top-level JSON object");
  });

  test("keeps multi-turn refinement conversational and activates tools only for /materia continue", async () => {
    const harness = await makeHarness("small", true);
    await harness.runCommand("materia", "cast refine then finalize");

    expect(harness.activeTools.some(isAgentHandoffToolName)).toBe(false);
    expect(latestState(harness).agentFinalization?.reason).toBe("not_finalization_turn");
    harness.appendAssistantMessage("Refinement response");
    await harness.emit("agent_end", { messages: [] });

    await harness.runCommand("materia", "continue");
    expect(latestState(harness).agentFinalization).toMatchObject({ strategy: "tool_backed", phase: "active" });
    expect(harness.activeTools).toContain(AGENT_HANDOFF_TOOL_NAMES.commit);
    expect(latestPrompt(harness)).toContain("tool-backed materia handoff submission is active");
  });
});

async function makeHarness(model = "small", multiTurn = false): Promise<FakePiHarness> {
  const cwd = await mkdtemp(path.join(tmpdir(), "pi-materia-finalization-strategy-"));
  await mkdir(path.join(cwd, ".pi"), { recursive: true });
  await writeFile(path.join(cwd, ".pi", "pi-materia.json"), JSON.stringify({
    artifactDir: ".pi/pi-materia",
    activeLoadout: "Test",
    finalization: {
      agentJson: {
        strategy: "tool_backed",
        qualifiedModels: [{ provider: "test", model: "small", api: "fake", socketIds: ["Socket-1"] }],
      },
    },
    loadouts: {
      Test: {
        entry: "Socket-1",
        sockets: {
          "Socket-1": {
            materia: "Plan",
            parse: "json",
            assign: { workItems: "$.workItems" },
          },
        },
      },
    },
    materia: {
      Plan: {
        type: "agent",
        tools: "readOnly",
        prompt: "Produce the requested plan.",
        model: `test/${model}`,
        ...(multiTurn ? { multiTurn: true } : {}),
      },
    },
  }, null, 2));
  const harness = new FakePiHarness(cwd);
  harness.models = [
    { provider: "test", id: "small", name: "Small", api: "fake" },
    { provider: "test", id: "other", name: "Other", api: "fake" },
  ];
  piMateria(harness.pi);
  return harness;
}

async function invoke(harness: FakePiHarness, name: string, args: Record<string, unknown>): Promise<unknown> {
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

function latestPrompt(harness: FakePiHarness): string {
  const message = harness.sentMessages
    .filter(({ message }) => (message as { customType?: string }).customType === "pi-materia-prompt")
    .at(-1)?.message as { content?: unknown } | undefined;
  return typeof message?.content === "string" ? message.content : "";
}

async function readRunEvents(state: MateriaCastState): Promise<any[]> {
  const text = await readFile(path.join(state.runDir, "events.jsonl"), "utf8");
  return text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}
