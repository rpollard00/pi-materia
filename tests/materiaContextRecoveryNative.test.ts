import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import piMateria from "../src/index.js";
import { recoveryIdentityKey } from "../src/application/recoveryPolicy.js";
import { appendMateriaPresentation } from "../src/presentation/materiaPresentation.js";
import { cancelNativeCast, reactivateQueuedNativeCast } from "../src/castRuntime.js";
import type { MateriaCastState } from "../src/types.js";
import { FakePiHarness } from "./fakePi.js";

function agentConfig() {
  return {
    artifactDir: ".pi/pi-materia",
    activeLoadout: "Test",
    loadouts: {
      Test: {
        entry: "Socket-1",
        sockets: { "Socket-1": { materia: "Build", edges: [{ when: "always", to: "end" }] } },
      },
    },
    materia: { Build: { tools: "coding", prompt: "Build materia for {{request}}" } },
  };
}

function jsonAgentConfig() {
  return {
    artifactDir: ".pi/pi-materia",
    activeLoadout: "Test",
    loadouts: {
      Test: {
        entry: "Socket-1",
        sockets: {
          "Socket-1": {
            materia: "Build",
            parse: "json",
            assign: { result: "$.context" },
            edges: [{ when: "always", to: "end" }],
          },
        },
      },
    },
    materia: { Build: { tools: "coding", prompt: "Build materia for {{request}}" } },
  };
}

async function makeHarness(config: unknown = agentConfig()): Promise<FakePiHarness> {
  const cwd = await mkdtemp(path.join(tmpdir(), "pi-materia-context-recovery-"));
  await mkdir(path.join(cwd, ".pi"), { recursive: true });
  await writeFile(path.join(cwd, ".pi", "pi-materia.json"), JSON.stringify(config, null, 2));
  const harness = new FakePiHarness(cwd);
  piMateria(harness.pi);
  return harness;
}

function latestState(harness: FakePiHarness): MateriaCastState {
  const entry = harness.appendedEntries.filter((candidate) => candidate.customType === "pi-materia-cast-state").at(-1);
  if (!entry?.data) throw new Error("expected a persisted cast state");
  return entry.data as MateriaCastState;
}

async function abortCast(harness: FakePiHarness): Promise<void> {
  await cancelNativeCast(harness.pi, latestState(harness));
}

function promptMessages(harness: FakePiHarness): unknown[] {
  return harness.sentMessages
    .map(({ message }) => message as Record<string, unknown>)
    .filter((message) => message.customType === "pi-materia-prompt")
    .map((message) => ({ role: "custom", ...message }));
}

function appendLegacyAndPresentationCards(harness: FakePiHarness, label: string): { legacy: string; presentation: string } {
  const legacy = `legacy-${label}-card`;
  const presentation = `presentation-${label}-card`;
  harness.sessionManager.appendCustomMessage("pi-materia", legacy, true, { prefix: "status" });
  appendMateriaPresentation(harness.pi, {
    content: presentation,
    details: { prefix: "status", materiaName: "orchestrator", eventType: "status" },
  });
  return { legacy, presentation };
}

async function contextMessages(harness: FakePiHarness, messages: unknown[]): Promise<unknown[]> {
  const results = await harness.emit("context", { messages });
  const result = results.at(-1) as { messages?: unknown[] } | undefined;
  return result?.messages ?? messages;
}

function expectValidRecoveredContext(harness: FakePiHarness, projected: unknown[], cards: { legacy: string; presentation: string }): void {
  const serialized = JSON.stringify(projected);
  const guard = (projected[0] as { content?: unknown } | undefined)?.content;
  const state = latestState(harness);

  expect(typeof guard).toBe("string");
  expect(guard).toContain("Materia isolated context.");
  expect(guard).toContain(`Cast id: ${state.castId}`);
  expect(guard).toContain(`Original request: ${state.request}`);
  expect(guard).toContain(`Current socket: ${state.currentSocketId}`);
  expect(guard).toContain(`Current materia: ${state.currentMateria}`);
  expect(serialized).not.toContain(cards.legacy);
  expect(serialized).not.toContain(cards.presentation);
  expect(projected.some((message) => (message as { customType?: unknown }).customType === "pi-materia-presentation")).toBe(false);

  // A presentation entry is durable transcript UI, not a custom message. This
  // catches recovery/replay adapters that rebuild entries as model messages.
  expect(harness.sessionManager.getEntries().some((entry) => entry.type === "custom_message" && (entry as { customType?: unknown }).customType === "pi-materia-presentation")).toBe(false);
}

describe("Materia context projection across recovery paths", () => {
  test("presentation cards before recast stay visible in session state but not in the recovered request", async () => {
    const harness = await makeHarness();
    await harness.runCommand("materia", "cast recast projection");
    const initialPrompt = promptMessages(harness)[0];
    await abortCast(harness);
    const cards = appendLegacyAndPresentationCards(harness, "recast");

    await harness.runCommand("materia", "recast");
    const projected = await contextMessages(harness, [
      { role: "user", content: [{ type: "text", text: "unrelated transcript" }] },
      ...((initialPrompt ? [initialPrompt] : [])),
      { role: "custom", customType: "pi-materia", content: cards.legacy },
      { role: "custom", customType: "pi-materia-presentation", content: cards.presentation },
      ...promptMessages(harness).slice(-1),
      { role: "toolResult", content: [{ type: "text", text: "recast tool result" }] },
    ]);

    expectValidRecoveredContext(harness, projected, cards);
    expect(promptMessages(harness).length).toBeGreaterThan(1);
  });

  test("passive revive restores cast context without dispatching a model turn or replaying cards", async () => {
    const harness = await makeHarness();
    await harness.runCommand("materia", "cast passive revive projection");
    const prompt = promptMessages(harness)[0];
    await abortCast(harness);
    const cards = appendLegacyAndPresentationCards(harness, "passive-revive");
    const turnsBefore = harness.operationLog.filter((operation) => operation === "triggerTurn").length;

    await harness.runCommand("materia", "revive");
    const projected = await contextMessages(harness, [
      { role: "user", content: [{ type: "text", text: "old transcript" }] },
      { role: "custom", customType: "pi-materia", content: cards.legacy },
      { role: "custom", customType: "pi-materia-presentation", content: cards.presentation },
      prompt,
      { role: "toolResult", content: [{ type: "text", text: "passive revive tool result" }] },
    ]);

    expectValidRecoveredContext(harness, projected, cards);
    expect(harness.operationLog.filter((operation) => operation === "triggerTurn")).toHaveLength(turnsBefore);
  });

  test("exhaustion revive re-dispatches the socket with cast context and no presentation messages", async () => {
    const harness = await makeHarness();
    await harness.runCommand("materia", "cast exhausted revive projection");
    const initialPrompt = promptMessages(harness)[0];
    await abortCast(harness);
    const failed = latestState(harness);
    const key = recoveryIdentityKey(failed);
    const failure = "same-socket recovery exhausted for projection";
    const exhausted = structuredClone(failed) as MateriaCastState;
    exhausted.failedReason = failure;
    exhausted.recoveryAllowances = { [key]: { originalMaxAttempts: 1, effectiveMaxAttempts: 1, reviveCount: 0 } };
    exhausted.recoveryExhaustion = {
      kind: "same_socket_recovery_exhausted",
      reason: "turn_failure",
      key,
      attempts: 1,
      originalMaxAttempts: 1,
      effectiveMaxAttempts: 1,
      reviveCount: 0,
      failedReason: failure,
      socket: "Socket-1",
      mode: "normal",
      exhaustedAt: Date.now(),
    };
    harness.pi.appendEntry("pi-materia-cast-state", exhausted);
    const cards = appendLegacyAndPresentationCards(harness, "exhaustion-revive");

    await harness.runCommand("materia", "revive");
    const projected = await contextMessages(harness, [
      { role: "user", content: [{ type: "text", text: "old transcript" }] },
      initialPrompt,
      { role: "custom", customType: "pi-materia", content: cards.legacy },
      { role: "custom", customType: "pi-materia-presentation", content: cards.presentation },
      ...promptMessages(harness).slice(-1),
    ]);

    expectValidRecoveredContext(harness, projected, cards);
    expect(latestState(harness).active).toBe(true);
  });

  test("JSON repair retry uses the latest hidden prompt, valid cast context, and no card content", async () => {
    const harness = await makeHarness(jsonAgentConfig());
    await harness.runCommand("materia", "cast JSON repair projection");
    const initialPrompt = promptMessages(harness)[0];
    harness.appendAssistantMessage("{ invalid JSON output }");
    await harness.emit("agent_end", { messages: [] });
    const cards = appendLegacyAndPresentationCards(harness, "json-repair");

    const projected = await contextMessages(harness, [
      { role: "user", content: [{ type: "text", text: "unrelated transcript" }] },
      initialPrompt,
      { role: "custom", customType: "pi-materia", content: cards.legacy },
      { role: "custom", customType: "pi-materia-presentation", content: cards.presentation },
      { role: "assistant", content: [{ type: "text", text: "{ invalid JSON output }" }] },
      ...promptMessages(harness).slice(-1),
      { role: "toolResult", content: [{ type: "text", text: "repair tool result" }] },
    ]);

    expectValidRecoveredContext(harness, projected, cards);
    expect(JSON.stringify(projected)).toContain("Return only corrected JSON");
  });

  test("Pi-native retry after an inference interruption retains cast context and excludes cards", async () => {
    const harness = await makeHarness();
    await harness.runCommand("materia", "cast native retry projection");
    const prompt = promptMessages(harness)[0];
    const cards = appendLegacyAndPresentationCards(harness, "native-retry");
    harness.appendAssistantMessage("", { stopReason: "error", errorMessage: "provider retry" });
    await harness.emit("agent_end", { messages: [] });

    const projected = await contextMessages(harness, [
      { role: "user", content: [{ type: "text", text: "unrelated transcript" }] },
      prompt,
      { role: "custom", customType: "pi-materia", content: cards.legacy },
      { role: "custom", customType: "pi-materia-presentation", content: cards.presentation },
      { role: "assistant", content: [{ type: "text", text: "partial failed turn" }] },
      { role: "toolResult", content: [{ type: "text", text: "native retry tool result" }] },
    ]);

    expectValidRecoveredContext(harness, projected, cards);
    expect(latestState(harness).inferenceInterruption).toBeDefined();
  });

  test("compaction retry projects a fresh cast guard while filtering legacy and replayed cards", async () => {
    const harness = await makeHarness();
    harness.contextUsage = { tokens: 900, contextWindow: 1_000, percent: 90 };
    await harness.runCommand("materia", "cast compaction retry projection");
    const prompt = promptMessages(harness)[0];
    const cards = appendLegacyAndPresentationCards(harness, "compaction-retry");

    const projected = await contextMessages(harness, [
      { role: "compactionSummary", summary: "pre-compaction unrelated transcript" },
      { role: "custom", customType: "pi-materia", content: cards.legacy },
      { role: "custom", customType: "pi-materia-presentation", content: cards.presentation },
      prompt,
      { role: "toolResult", content: [{ type: "text", text: "compaction retry tool result" }] },
    ]);

    expect(harness.operationLog.filter((operation) => operation === "compact").length).toBeGreaterThan(0);
    expectValidRecoveredContext(harness, projected, cards);
  });

  test("quest-linked reactivation keeps the original cast context and never replays presentation entries", async () => {
    const harness = await makeHarness();
    await harness.runCommand("materia", "cast queued quest projection");
    const prompt = promptMessages(harness)[0];
    await abortCast(harness);
    const failed = latestState(harness);
    const queued = structuredClone(failed) as MateriaCastState;
    queued.data.quest = { questId: "quest-projection", title: "Queued projection quest" };
    queued.data.questQueuedResurrection = { questId: "quest-projection", resumeCastId: queued.castId };
    harness.pi.appendEntry("pi-materia-cast-state", queued);
    const cards = appendLegacyAndPresentationCards(harness, "quest-reactivation");
    const turnsBefore = harness.operationLog.filter((operation) => operation === "triggerTurn").length;

    await reactivateQueuedNativeCast(harness.pi, harness.ctx, queued.castId);
    const projected = await contextMessages(harness, [
      { role: "user", content: [{ type: "text", text: "old quest transcript" }] },
      { role: "custom", customType: "pi-materia", content: cards.legacy },
      { role: "custom", customType: "pi-materia-presentation", content: cards.presentation },
      prompt,
      { role: "toolResult", content: [{ type: "text", text: "quest reactivation tool result" }] },
    ]);

    expectValidRecoveredContext(harness, projected, cards);
    expect(harness.operationLog.filter((operation) => operation === "triggerTurn")).toHaveLength(turnsBefore);
    expect(latestState(harness).active).toBe(true);
  });
});
