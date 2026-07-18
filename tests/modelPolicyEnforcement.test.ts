import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { applyMateriaModelSettings } from "../src/config/modelSettings.js";
import type { ModelPolicyDocument } from "../src/domain/modelPolicy.js";
import { materiaModelSelection } from "../src/runtime/modelSelection.js";
import {
  createLocalModelPolicyResolver,
  getActiveModelPolicyResolver,
  resetModelPolicyResolver,
  resolveActiveModelPolicy,
  setActiveModelPolicyResolver,
} from "../src/runtime/modelPolicyResolver.js";
import { FakePiHarness } from "./fakePi.js";

const GPT = { provider: "openai", id: "gpt-test", name: "GPT Test", api: "openai" };
const CLAUDE = { provider: "anthropic", id: "claude-test", name: "Claude Test", api: "anthropic" };

function policy(overrides: Partial<ModelPolicyDocument> & Pick<ModelPolicyDocument, "id"> = {}): ModelPolicyDocument {
  return { id: "policy-1", ...overrides };
}

async function makeHarness(activeModel: Record<string, unknown> = GPT, thinkingLevel = "medium"): Promise<FakePiHarness> {
  const cwd = await mkdtemp(path.join(tmpdir(), "pi-materia-modelpolicy-"));
  const harness = new FakePiHarness(cwd);
  harness.models = [GPT, CLAUDE];
  harness.activeModel = activeModel;
  (harness.ctx as unknown as { model: unknown }).model = activeModel;
  harness.thinkingLevel = thinkingLevel;
  return harness;
}

afterEach(() => {
  resetModelPolicyResolver();
});

describe("applyMateriaModelSettings — model policy enforcement", () => {
  test("no policy preserves existing local selection behavior exactly", async () => {
    const harness = await makeHarness();
    const result = await applyMateriaModelSettings(harness.pi, harness.ctx, {
      materiaName: "Build",
      model: "anthropic/claude-test",
      thinking: "high",
    });

    expect(harness.setModelCalls).toEqual([CLAUDE]);
    expect(harness.setThinkingLevelCalls).toEqual(["high"]);
    expect(result.modelPolicyEvaluated).toBeUndefined();
    expect(result.modelPolicyDenied).toBeUndefined();
    expect(result.preferredSuggestion).toBeUndefined();
    expect(result.thinkingPolicyClamped).toBeUndefined();
  });

  test("no policy with nothing configured is a pure no-op", async () => {
    const harness = await makeHarness();
    const result = await applyMateriaModelSettings(harness.pi, harness.ctx, { materiaName: "Build" });

    expect(harness.setModelCalls).toHaveLength(0);
    expect(harness.setThinkingLevelCalls).toHaveLength(0);
    expect(result.modelExplicit).toBe(false);
    expect(result.thinkingExplicit).toBe(false);
    expect(result.modelPolicyEvaluated).toBeUndefined();
  });

  test("a constraint-free policy is treated as unconstrained (passthrough)", async () => {
    const harness = await makeHarness();
    const result = await applyMateriaModelSettings(harness.pi, harness.ctx, {
      materiaName: "Build",
      model: "anthropic/claude-test",
      thinking: "high",
      policy: policy({ description: "no rules" }),
    });

    expect(harness.setModelCalls).toEqual([CLAUDE]);
    expect(harness.setThinkingLevelCalls).toEqual(["high"]);
    // policyHasConstraints is false, so evaluation is skipped entirely.
    expect(result.modelPolicyEvaluated).toBeUndefined();
  });

  test("denied configured model is never selected and falls back to active", async () => {
    const harness = await makeHarness();
    const result = await applyMateriaModelSettings(harness.pi, harness.ctx, {
      materiaName: "Build",
      model: "anthropic/claude-test",
      thinking: "high",
      policy: policy({ deny: [{ value: "anthropic/claude-test" }] }),
    });

    expect(harness.setModelCalls).toHaveLength(0);
    expect(result.modelPolicyEvaluated).toBe(true);
    expect(result.modelPolicyDenied).toEqual({ reason: "model_denied", message: expect.stringContaining("denied") });
    expect(result.modelFallbackReason).toBe("policy_denied");
    // Fell back to the active Pi session model.
    expect(result.provider).toBe("openai");
    expect(result.modelId).toBe("gpt-test");
    expect(harness.notifications.some((n) => n.type === "warning" && n.message.includes("not applied"))).toBe(true);
  });

  test("denial flows through materiaModelSelection as an active fallback", async () => {
    const harness = await makeHarness();
    const result = await applyMateriaModelSettings(harness.pi, harness.ctx, {
      materiaName: "Build",
      model: "anthropic/claude-test",
      policy: policy({ deny: [{ value: "anthropic/claude-test" }] }),
    });
    const selection = materiaModelSelection(result);

    expect(selection.source).toBe("active");
    expect(selection.modelFallbackReason).toBe("policy_denied");
    expect(selection.model).toBe("gpt-test");
  });

  test("enforced allow-list excludes a configured model (hard denial)", async () => {
    const harness = await makeHarness();
    const result = await applyMateriaModelSettings(harness.pi, harness.ctx, {
      materiaName: "Build",
      model: "anthropic/claude-test",
      policy: policy({ severity: "enforced", allow: [{ value: "openai/gpt-test" }] }),
    });

    expect(harness.setModelCalls).toHaveLength(0);
    expect(result.modelPolicyDenied?.reason).toBe("model_not_allowed");
    expect(result.modelFallbackReason).toBe("policy_denied");
  });

  test("advisory allow-list warns but still applies the configured model", async () => {
    const harness = await makeHarness();
    const result = await applyMateriaModelSettings(harness.pi, harness.ctx, {
      materiaName: "Build",
      model: "anthropic/claude-test",
      policy: policy({ severity: "advisory", allow: [{ value: "openai/gpt-test" }] }),
    });

    expect(harness.setModelCalls).toEqual([CLAUDE]);
    expect(result.modelPolicyDenied).toBeUndefined();
    expect(result.modelFallbackReason).toBeUndefined();
    expect(harness.notifications.some((n) => n.type === "warning" && n.message.includes("allowed set"))).toBe(true);
  });

  test("preferred model is advisory: surfaced but not auto-selected", async () => {
    const harness = await makeHarness();
    const result = await applyMateriaModelSettings(harness.pi, harness.ctx, {
      materiaName: "Build",
      model: "openai/gpt-test",
      policy: policy({ prefer: [{ value: "anthropic/claude-test" }] }),
    });

    // Configured model is still applied (prefer is advisory, not a switch).
    expect(harness.setModelCalls).toEqual([GPT]);
    expect(result.preferredSuggestion).toEqual({ modelValue: "anthropic/claude-test" });
    expect(result.modelPolicyDenied).toBeUndefined();
    expect(harness.notifications).toContainEqual({
      type: "info",
      message: expect.stringContaining('prefers "anthropic/claude-test"'),
    });
  });

  test("preferred model unavailable locally produces a warning and no suggestion", async () => {
    const harness = await makeHarness();
    const result = await applyMateriaModelSettings(harness.pi, harness.ctx, {
      materiaName: "Build",
      model: "openai/gpt-test",
      policy: policy({ prefer: [{ value: "google/gemini" }] }),
    });

    expect(harness.setModelCalls).toEqual([GPT]);
    expect(result.preferredSuggestion).toBeUndefined();
    expect(harness.notifications.some((n) => n.type === "warning" && n.message.includes("not available locally"))).toBe(true);
  });

  test("thinking max constraint clamps an explicit thinking level", async () => {
    const harness = await makeHarness();
    const result = await applyMateriaModelSettings(harness.pi, harness.ctx, {
      materiaName: "Build",
      model: "openai/gpt-test",
      thinking: "high",
      policy: policy({ thinking: { max: "medium" } }),
    });

    expect(harness.setThinkingLevelCalls).toEqual(["medium"]);
    expect(result.thinkingPolicyClamped).toBe(true);
    expect(result.thinking).toBe("medium");
    expect(harness.notifications.some((n) => n.type === "warning" && n.message.includes("suggested clamp"))).toBe(true);
  });

  test("thinking clamp applies even with no explicit thinking when the active level violates", async () => {
    const harness = await makeHarness(GPT, "high");
    const result = await applyMateriaModelSettings(harness.pi, harness.ctx, {
      materiaName: "Build",
      policy: policy({ thinking: { max: "medium" } }),
    });

    expect(harness.setModelCalls).toHaveLength(0);
    expect(harness.setThinkingLevelCalls).toEqual(["medium"]);
    expect(result.thinkingPolicyClamped).toBe(true);
    expect(result.modelPolicyEvaluated).toBe(true);
  });

  test("denied active model with no configured model warns and continues gracefully", async () => {
    const harness = await makeHarness(GPT, "medium");
    const result = await applyMateriaModelSettings(harness.pi, harness.ctx, {
      materiaName: "Build",
      policy: policy({ deny: [{ value: "openai/gpt-test" }] }),
    });

    expect(harness.setModelCalls).toHaveLength(0);
    expect(result.modelPolicyDenied).toBeUndefined();
    expect(harness.notifications.some((n) => n.type === "warning" && n.message.includes("denied by policy"))).toBe(true);
  });
});

describe("runtime model-policy resolver seam", () => {
  test("local resolver returns undefined (preserves local behavior)", async () => {
    const harness = await makeHarness();
    const resolver = createLocalModelPolicyResolver();
    await expect(resolver.resolveActivePolicy({ pi: harness.pi, ctx: harness.ctx })).resolves.toBeUndefined();
  });

  test("default active resolver is local and resolves undefined", async () => {
    const harness = await makeHarness();
    const local = createLocalModelPolicyResolver();
    // The registered default behaves like a fresh local resolver (no policy).
    await expect(getActiveModelPolicyResolver().resolveActivePolicy({ pi: harness.pi, ctx: harness.ctx })).resolves.toBeUndefined();
    await expect(resolveActiveModelPolicy(harness.pi, harness.ctx)).resolves.toBeUndefined();
    expect(local).not.toBe(getActiveModelPolicyResolver());
  });

  test("a registered resolver supplies the active policy and reset restores the default", async () => {
    const harness = await makeHarness();
    const doc = policy({ deny: [{ value: "anthropic/claude-test" }] });
    setActiveModelPolicyResolver({ async resolveActivePolicy() { return doc; } });

    await expect(resolveActiveModelPolicy(harness.pi, harness.ctx)).resolves.toEqual(doc);

    resetModelPolicyResolver();
    await expect(resolveActiveModelPolicy(harness.pi, harness.ctx)).resolves.toBeUndefined();
  });
});
