import { describe, expect, test } from "bun:test";
import { TOOL_SCOPE_PRESET_OPTIONS, resolveToolScope, validateToolScopeSpecShape } from "../src/domain/toolScope.js";
import { updateToolScope } from "../src/runtime/agentTurnState.js";
import { buildMateriaPatch, emptyMateriaForm } from "../src/webui/client/src/webui/utils/forms.js";

const available = ["read", "grep", "find", "ls", "bash", "edit", "write"];

describe("tool scope resolution", () => {
  test("preserves existing preset behavior without custom availability warnings", () => {
    expect(resolveToolScope("none", available)).toEqual({ ok: true, value: resolvedPreset("none", []) });
    expect(resolveToolScope("readOnly", available)).toEqual({ ok: true, value: resolvedPreset("readOnly", ["read", "grep", "find", "ls"]) });
    expect(resolveToolScope("coding", available)).toEqual({ ok: true, value: resolvedPreset("coding", available) });
  });

  test("treats unavailable custom tool names as soft availability metadata", () => {
    expect(resolveToolScope({ type: "custom", tools: ["read", "extensionTool"] }, available)).toEqual({
      ok: true,
      value: resolvedCustom(["read", "extensionTool"], ["read"], ["extensionTool"]),
    });
  });

  test("preserves exact configured custom names while activating only available names", () => {
    expect(resolveToolScope({ type: "custom", tools: ["bash", "read"] }, available)).toEqual({
      ok: true,
      value: resolvedCustom(["bash", "read"], ["bash", "read"], []),
    });
    expect(resolveToolScope({ type: "custom", tools: ["read", "extensionTool"] })).toEqual({
      ok: true,
      value: resolvedCustom(["read", "extensionTool"], ["read", "extensionTool"], []),
    });
  });

  test("handles empty and duplicate custom allowlists deterministically", () => {
    expect(resolveToolScope({ type: "custom", tools: [] }, available)).toEqual({ ok: true, value: resolvedCustom([], [], []) });
    expect(resolveToolScope({ type: "custom", tools: ["bash", "read", "bash", "grep", "missing", "missing"] }, available)).toEqual({
      ok: true,
      value: resolvedCustom(["bash", "read", "bash", "grep", "missing", "missing"], ["bash", "read", "grep"], ["missing"]),
    });
  });

  test("rejects malformed tool scope shapes", () => {
    const cases: Array<[unknown, string]> = [
      [["read"], "materia.Build.tools"],
      [{ type: "unknown", tools: ["read"] }, "materia.Build.tools.type"],
      [{ type: "custom", tools: "read" }, "materia.Build.tools.tools"],
      [{ type: "custom", tools: ["read", 1] }, "materia.Build.tools.tools"],
      [{ type: "custom", tools: ["read", "  "] }, "materia.Build.tools.tools"],
    ];

    for (const [value, issuePath] of cases) {
      const invalid = validateToolScopeSpecShape(value, "materia.Build.tools");
      expect(invalid.ok).toBe(false);
      if (!invalid.ok) expect(invalid.issues[0]?.path).toBe(issuePath);

      const resolved = resolveToolScope(value, available, "materia.Build.tools");
      expect(resolved.ok).toBe(false);
      if (!resolved.ok) expect(resolved.issues[0]?.path).toBe(issuePath);
    }
  });

  test("webui metadata consumes shared tool scope options and preserves custom allowlists", () => {
    expect(TOOL_SCOPE_PRESET_OPTIONS.map((option) => option.value)).toEqual(["coding", "readOnly", "none"]);

    const patch = buildMateriaPatch({
      ...emptyMateriaForm(),
      name: "Eval",
      prompt: "Evaluate.",
      toolAccess: { type: "custom", tools: ["read", "bash"] },
    });

    expect(patch.materia?.Eval?.tools).toEqual({ type: "custom", tools: ["read", "bash"] });
  });

  test("runtime receives only the resolved active tool list", () => {
    const pi = {
      getAllTools: () => available.map((name) => ({ name })),
      setActiveTools: (tools: string[]) => { pi.activeTools = tools; },
      activeTools: [] as string[],
    };

    updateToolScope(pi as never, { tools: { type: "custom", tools: ["bash", "read"] }, prompt: "Evaluate." });

    expect(pi.activeTools).toEqual(["bash", "read"]);
  });

  test("runtime fails closed for malformed custom allowlists", () => {
    const pi = {
      getAllTools: () => available.map((name) => ({ name })),
      setActiveTools: (tools: string[]) => { pi.activeTools = tools; },
      activeTools: ["read"] as string[],
    };

    expect(() => updateToolScope(pi as never, { tools: { type: "custom", tools: [" "] }, prompt: "Evaluate." })).toThrow(/Invalid materia tool scope: .*non-empty tool names/);
    expect(pi.activeTools).toEqual(["read"]);
  });
});

function resolvedPreset(spec: "none" | "readOnly" | "coding", tools: readonly string[]) {
  return { spec, source: "preset", tools, configuredTools: [], activeTools: tools, unavailableTools: [], warnings: [] };
}

function resolvedCustom(configuredTools: readonly string[], activeTools: readonly string[], unavailableTools: readonly string[]) {
  return {
    spec: { type: "custom", tools: configuredTools },
    source: "custom",
    tools: activeTools,
    configuredTools,
    activeTools,
    unavailableTools,
    warnings: unavailableTools.length > 0
      ? [`Unavailable custom tool name(s) will be skipped at runtime until registered: ${unavailableTools.join(", ")}`]
      : [],
  };
}
