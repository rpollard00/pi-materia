import { describe, expect, test } from "bun:test";
// Import from the domain module to assert domain-layer placement and purity.
import {
  MODEL_POLICY_SEVERITIES,
  availableRuntimeModel,
  evaluateModelPolicy,
  isModelPolicyModelRef,
  isModelPolicySeverity,
  isModelPolicyThinkingConstraint,
  isValidModelPolicyDocument,
  modelPolicyAllowsThinking,
  modelPolicyAllowsValue,
  modelPolicyDeniesValue,
  policyHasConstraints,
  policySeverity,
  selectPolicyPreferredModel,
  suggestThinkingLevel,
  toAvailableRuntimeModels,
  unavailablePreferredModels,
  type ModelPolicyDocument,
} from "../src/domain/modelPolicy.js";
// The application control-plane surface must re-export the same contracts.
import {
  evaluateModelPolicy as evaluateModelPolicyViaApp,
  isValidModelPolicyDocument as isValidViaApp,
} from "../src/application/controlPlane.js";

const ALL_MODELS = ["zai/glm-4.6", "anthropic/claude", "openai/gpt-4o", "google/gemini"];

function doc(overrides: Partial<ModelPolicyDocument> & Pick<ModelPolicyDocument, "id"> = {}): ModelPolicyDocument {
  return { id: "policy-1", ...overrides };
}

describe("model policy — document guards", () => {
  test("isModelPolicyModelRef validates value", () => {
    expect(isModelPolicyModelRef({ value: "zai/glm-4.6" })).toBe(true);
    expect(isModelPolicyModelRef({ value: "zai/glm-4.6", label: "GLM" })).toBe(true);
    expect(isModelPolicyModelRef({ value: "" })).toBe(false);
    expect(isModelPolicyModelRef({ value: "   " })).toBe(false);
    expect(isModelPolicyModelRef({ label: "no value" })).toBe(false);
    expect(isModelPolicyModelRef(null)).toBe(false);
  });

  test("isModelPolicySeverity + MODEL_POLICY_SEVERITIES", () => {
    expect([...MODEL_POLICY_SEVERITIES]).toEqual(["advisory", "enforced"]);
    expect(isModelPolicySeverity("advisory")).toBe(true);
    expect(isModelPolicySeverity("enforced")).toBe(true);
    expect(isModelPolicySeverity("hard")).toBe(false);
  });

  test("isModelPolicyThinkingConstraint", () => {
    expect(isModelPolicyThinkingConstraint({ allow: ["low", "medium"] })).toBe(true);
    expect(isModelPolicyThinkingConstraint({ max: "high" })).toBe(true);
    expect(isModelPolicyThinkingConstraint({})).toBe(true);
    expect(isModelPolicyThinkingConstraint({ allow: ["low", "nuclear"] })).toBe(false);
    expect(isModelPolicyThinkingConstraint({ max: "turbo" })).toBe(false);
    expect(isModelPolicyThinkingConstraint({ allow: "low" })).toBe(false);
    expect(isModelPolicyThinkingConstraint(null)).toBe(false);
  });

  test("isValidModelPolicyDocument", () => {
    expect(isValidModelPolicyDocument(doc())).toBe(true);
    expect(isValidModelPolicyDocument(doc({ allow: [{ value: "zai/glm-4.6" }], deny: [], prefer: [{ value: "x" }], thinking: { max: "high" }, severity: "advisory", version: "v1", updatedAt: "2026-01-01T00:00:00Z" }))).toBe(true);
    expect(isValidModelPolicyDocument({ id: "" })).toBe(false);
    expect(isValidModelPolicyDocument({ id: "x", severity: "hard" })).toBe(false);
    expect(isValidModelPolicyDocument({ id: "x", allow: [{ foo: 1 }] })).toBe(false);
    expect(isValidModelPolicyDocument({ id: "x", thinking: { allow: ["nuclear"] } })).toBe(false);
    expect(isValidModelPolicyDocument({ id: "x", version: 5 })).toBe(false);
    expect(isValidModelPolicyDocument(null)).toBe(false);
    expect(isValidViaApp(doc({ allow: [{ value: "zai/glm-4.6" }] }))).toBe(true);
  });

  test("policyHasConstraints + policySeverity defaults", () => {
    expect(policyHasConstraints(undefined)).toBe(false);
    expect(policyHasConstraints(doc())).toBe(false);
    expect(policyHasConstraints(doc({ deny: [{ value: "x" }] }))).toBe(true);
    expect(policyHasConstraints(doc({ allow: [] }))).toBe(false);
    expect(policyHasConstraints(doc({ thinking: { max: "high" } }))).toBe(true);
    expect(policySeverity(doc())).toBe("enforced");
    expect(policySeverity(doc({ severity: "advisory" }))).toBe("advisory");
  });
});

describe("model policy — low-level helpers", () => {
  const refs = [{ value: "zai/glm-4.6" }, { value: "openai/gpt-4o" }];

  test("modelPolicyAllowsValue", () => {
    expect(modelPolicyAllowsValue(refs, "zai/glm-4.6")).toBe(true);
    expect(modelPolicyAllowsValue(refs, "anthropic/claude")).toBe(false);
    expect(modelPolicyAllowsValue(undefined, "anything")).toBe(true);
    expect(modelPolicyAllowsValue([], "zai/glm-4.6")).toBe(true);
    expect(modelPolicyAllowsValue(refs, undefined)).toBe(false);
  });

  test("modelPolicyDeniesValue", () => {
    expect(modelPolicyDeniesValue(refs, "zai/glm-4.6")).toBe(true);
    expect(modelPolicyDeniesValue(refs, "anthropic/claude")).toBe(false);
    expect(modelPolicyDeniesValue(undefined, "zai/glm-4.6")).toBe(false);
    expect(modelPolicyDeniesValue(refs, undefined)).toBe(false);
  });

  test("modelPolicyAllowsThinking", () => {
    expect(modelPolicyAllowsThinking(undefined, "high")).toBe(true);
    const allowList = { allow: ["low", "medium"] as const };
    expect(modelPolicyAllowsThinking(allowList, "low")).toBe(true);
    expect(modelPolicyAllowsThinking(allowList, "high")).toBe(false);
    expect(modelPolicyAllowsThinking(allowList, undefined)).toBe(false);
    const ceiling = { max: "medium" as const };
    expect(modelPolicyAllowsThinking(ceiling, "medium")).toBe(true);
    expect(modelPolicyAllowsThinking(ceiling, "high")).toBe(false);
    expect(modelPolicyAllowsThinking(ceiling, "off")).toBe(true);
  });

  test("suggestThinkingLevel clamps within the constraint", () => {
    expect(suggestThinkingLevel(undefined)).toBeUndefined();
    expect(suggestThinkingLevel({ max: "medium" })).toBe("medium");
    // allow only → highest allowed
    expect(suggestThinkingLevel({ allow: ["low", "medium", "high"] })).toBe("high");
    // allow + max → highest allowed within ceiling
    expect(suggestThinkingLevel({ allow: ["low", "medium", "high"], max: "medium" })).toBe("medium");
    // max excludes every allowed level → contradictory; no level satisfies
    expect(suggestThinkingLevel({ allow: ["high", "xhigh"], max: "low" })).toBeUndefined();
    expect(suggestThinkingLevel({ allow: [] })).toBeUndefined();
  });
});

describe("model policy — prefer advisory selection", () => {
  const available = toAvailableRuntimeModels(["zai/glm-4.6", "openai/gpt-4o"]);

  test("selectPolicyPreferredModel picks first available+allowed in document order", () => {
    const policy = doc({ prefer: [{ value: "anthropic/claude" }, { value: "openai/gpt-4o" }, { value: "zai/glm-4.6" }] });
    expect(selectPolicyPreferredModel(policy, available)?.modelValue).toBe("openai/gpt-4o");
  });

  test("selectPolicyPreferredModel respects deny and allow lists", () => {
    expect(selectPolicyPreferredModel(doc({ prefer: [{ value: "zai/glm-4.6" }], deny: [{ value: "zai/glm-4.6" }] }), available)).toBeUndefined();
    expect(selectPolicyPreferredModel(doc({ prefer: [{ value: "zai/glm-4.6" }], allow: [{ value: "openai/gpt-4o" }] }), available)).toBeUndefined();
    expect(selectPolicyPreferredModel(doc({ prefer: [{ value: "zai/glm-4.6" }], allow: [{ value: "zai/glm-4.6" }] }), available)?.modelValue).toBe("zai/glm-4.6");
  });

  test("selectPolicyPreferredModel returns undefined when none available/preferred", () => {
    expect(selectPolicyPreferredModel(doc({}), available)).toBeUndefined();
    expect(selectPolicyPreferredModel(doc({ prefer: [{ value: "anthropic/claude" }] }), available)).toBeUndefined();
  });

  test("unavailablePreferredModels lists preferred not present locally", () => {
    expect(unavailablePreferredModels(doc({ prefer: [{ value: "zai/glm-4.6" }, { value: "anthropic/claude" }] }), available)).toEqual(["anthropic/claude"]);
    expect(unavailablePreferredModels(doc({}), available)).toEqual([]);
  });

  test("availableRuntimeModel factory keeps supportedThinkingLevels optional", () => {
    expect(availableRuntimeModel("zai/glm-4.6")).toEqual({ value: "zai/glm-4.6" });
    expect(availableRuntimeModel("zai/glm-4.6", ["low", "high"])).toEqual({ value: "zai/glm-4.6", supportedThinkingLevels: ["low", "high"] });
  });
});

describe("model policy — evaluateModelPolicy selection", () => {
  const available = toAvailableRuntimeModels(ALL_MODELS);

  test("no policy and constraint-free policy preserve existing selection (unconstrained)", () => {
    expect(evaluateModelPolicy({ policy: undefined, candidate: { modelValue: "zai/glm-4.6" }, available })).toEqual({
      status: "allowed",
      unconstrained: true,
      warnings: [],
    });
    expect(evaluateModelPolicy({ policy: doc(), candidate: { modelValue: "zai/glm-4.6" }, available })).toEqual({
      status: "allowed",
      unconstrained: true,
      warnings: [],
    });
  });

  test("deny is hard and overrides everything, including being preferred", () => {
    const policy = doc({ deny: [{ value: "openai/gpt-4o" }], prefer: [{ value: "openai/gpt-4o" }] });
    const result = evaluateModelPolicy({ policy, candidate: { modelValue: "openai/gpt-4o" }, available });
    expect(result.status).toBe("denied");
    expect(result.unconstrained).toBe(false);
    expect(result.denialReason).toBe("model_denied");
    expect(result.denialMessage).toContain("openai/gpt-4o");
    expect(result.warnings).toEqual([]);
    // advisory severity does not soften deny
    const advisory = evaluateModelPolicy({ policy: doc({ severity: "advisory", deny: [{ value: "openai/gpt-4o" }] }), candidate: { modelValue: "openai/gpt-4o" }, available });
    expect(advisory.status).toBe("denied");
    expect(advisory.denialReason).toBe("model_denied");
  });

  test("allow under enforced severity denies selection outside the set", () => {
    const policy = doc({ allow: [{ value: "zai/glm-4.6" }, { value: "anthropic/claude" }] });
    const denied = evaluateModelPolicy({ policy, candidate: { modelValue: "openai/gpt-4o" }, available });
    expect(denied.status).toBe("denied");
    expect(denied.denialReason).toBe("model_not_allowed");
    const ok = evaluateModelPolicy({ policy, candidate: { modelValue: "zai/glm-4.6" }, available });
    expect(ok.status).toBe("allowed");
    expect(ok.unconstrained).toBe(false);
    expect(ok.warnings).toEqual([]);
  });

  test("allow under advisory severity only warns for out-of-set selection", () => {
    const policy = doc({ severity: "advisory", allow: [{ value: "zai/glm-4.6" }] });
    const result = evaluateModelPolicy({ policy, candidate: { modelValue: "openai/gpt-4o" }, available });
    expect(result.status).toBe("allowed");
    expect(result.warnings.some((w) => w.includes("not in the policy allowed set"))).toBe(true);
  });

  test("prefer surfaces a suggestion and a warning when the preferred model is unavailable locally", () => {
    const policy = doc({ prefer: [{ value: "anthropic/claude" }] });
    const result = evaluateModelPolicy({ policy, candidate: { modelValue: "zai/glm-4.6" }, available: toAvailableRuntimeModels(["zai/glm-4.6"]) });
    expect(result.status).toBe("allowed");
    expect(result.preferredSuggestion).toBeUndefined();
    expect(result.warnings.some((w) => w.includes("not available locally"))).toBe(true);
    // when the preferred model IS available, it is suggested without a warning
    const present = evaluateModelPolicy({ policy, candidate: { modelValue: "zai/glm-4.6" }, available });
    expect(present.preferredSuggestion?.modelValue).toBe("anthropic/claude");
    expect(present.warnings).toEqual([]);
  });

  test("thinking violation clamps instead of hard-denying, with a suggestion", () => {
    const policy = doc({ thinking: { max: "medium" } });
    const result = evaluateModelPolicy({ policy, candidate: { modelValue: "zai/glm-4.6", thinkingLevel: "xhigh" }, available });
    expect(result.status).toBe("allowed");
    expect(result.suggestedThinkingLevel).toBe("medium");
    expect(result.warnings.some((w) => w.includes("suggested clamp"))).toBe(true);
  });

  test("thinking allow-list violation clamps to the highest allowed level within the ceiling", () => {
    const policy = doc({ thinking: { allow: ["low", "medium", "high"], max: "medium" } });
    const result = evaluateModelPolicy({ policy, candidate: { modelValue: "zai/glm-4.6", thinkingLevel: "xhigh" }, available });
    expect(result.status).toBe("allowed");
    expect(result.suggestedThinkingLevel).toBe("medium");
  });

  test("satisfied thinking produces no suggestion", () => {
    const policy = doc({ thinking: { max: "high" } });
    const result = evaluateModelPolicy({ policy, candidate: { modelValue: "zai/glm-4.6", thinkingLevel: "medium" }, available });
    expect(result.status).toBe("allowed");
    expect(result.suggestedThinkingLevel).toBeUndefined();
    expect(result.warnings).toEqual([]);
  });

  test("combined deny + allow: a denied candidate is rejected even when also disallowed", () => {
    const policy = doc({ deny: [{ value: "openai/gpt-4o" }], allow: [{ value: "zai/glm-4.6" }] });
    const result = evaluateModelPolicy({ policy, candidate: { modelValue: "openai/gpt-4o" }, available });
    expect(result.status).toBe("denied");
    expect(result.denialReason).toBe("model_denied");
  });

  test("application-layer re-export evaluates identically", () => {
    const policy = doc({ deny: [{ value: "openai/gpt-4o" }] });
    expect(evaluateModelPolicyViaApp({ policy, candidate: { modelValue: "openai/gpt-4o" }, available })).toEqual(
      evaluateModelPolicy({ policy, candidate: { modelValue: "openai/gpt-4o" }, available }),
    );
  });
});
