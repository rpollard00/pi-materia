import { describe, expect, test } from "bun:test";
import { TOOL_SCOPE_PRESET_OPTIONS, resolveToolScope, validateToolScopeSpecShape } from "../src/domain/toolScope.js";
import { updateToolScope } from "../src/runtime/agentTurnState.js";
import { buildMateriaPatch, emptyMateriaForm } from "../src/webui/client/src/webui/utils/forms.js";

const available = ["read", "grep", "find", "ls", "bash", "edit", "write"];

describe("tool scope resolution", () => {
  test("preserves existing preset behavior", () => {
    expect(resolveToolScope("none", available)).toEqual({ ok: true, value: { spec: "none", source: "preset", tools: [] } });
    expect(resolveToolScope("readOnly", available)).toEqual({ ok: true, value: { spec: "readOnly", source: "preset", tools: ["read", "grep", "find", "ls"] } });
    expect(resolveToolScope("coding", available)).toEqual({ ok: true, value: { spec: "coding", source: "preset", tools: available } });
  });

  test("validates normalized custom allowlists without broad fallback", () => {
    expect(resolveToolScope({ type: "custom", tools: ["read", "bash"] }, available)).toEqual({ ok: true, value: { spec: { type: "custom", tools: ["read", "bash"] }, source: "custom", tools: ["read", "bash"] } });
    const invalid = resolveToolScope({ type: "custom", tools: ["bsh"] }, available, "materia.Build.tools");
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.issues[0]?.message).toContain("bsh");
  });

  test("rejects malformed tool scope shape", () => {
    const invalid = validateToolScopeSpecShape(["read"], "materia.Build.tools");
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.issues[0]?.path).toBe("materia.Build.tools");
  });

  test("webui metadata consumes shared tool scope options and preserves custom allowlists", () => {
    expect(TOOL_SCOPE_PRESET_OPTIONS.map((option) => option.value)).toEqual(["none", "readOnly", "coding"]);

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

    expect(pi.activeTools).toEqual(["read", "bash"]);
  });
});
