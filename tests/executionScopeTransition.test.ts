import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  activateUtilityScopeTransition,
  extractUtilityScopeTransition,
} from "../src/application/executionScopeTransition.js";
import { cloneExecutionScope, createBaseExecutionScope } from "../src/domain/executionScope.js";
import { routeAgentToolCallToActiveScope } from "../src/runtime/activeScopeToolRouting.js";
import type { MateriaCastState } from "../src/types.js";

function scopedState(baseCwd: string): MateriaCastState {
  const baseScope = createBaseExecutionScope("cast-1", baseCwd);
  return {
    active: true,
    socketState: "awaiting_agent_response",
    baseScope,
    activeScope: cloneExecutionScope(baseScope),
    branchScopes: {},
  } as MateriaCastState;
}

describe("utility execution scope transitions", () => {
  test("activates replacement scopes and can later return to the immutable base", async () => {
    const base = await mkdtemp(path.join(tmpdir(), "materia-base-"));
    const branch = await mkdtemp(path.join(tmpdir(), "materia-branch-"));
    const state = scopedState(base);

    activateUtilityScopeTransition(state, {
      kind: "replace",
      scope: { id: "scope:branch", cwd: branch, state: { bookmark: "work" }, exports: { result: { producer: "test", value: 1 } } },
    });
    expect(state.activeScope.cwd).toBe(branch);
    expect(state.branchScopes["scope:branch"]).toEqual(state.activeScope);
    expect(state.branchScopes["scope:branch"]).not.toBe(state.activeScope);

    activateUtilityScopeTransition(state, { kind: "base" });
    expect(state.activeScope).toEqual(state.baseScope);
    expect(state.activeScope).not.toBe(state.baseScope);
    expect(state.branchScopes["scope:branch"]?.cwd).toBe(branch);
  });

  test("rejects malformed transitions without leaking the sidecar", () => {
    expect(() => extractUtilityScopeTransition('{"scopeTransition":{"kind":"replace","scope":{"id":"x","cwd":"/tmp"}}}')).not.toThrow();
    expect(() => extractUtilityScopeTransition('{"scopeTransition":{"kind":"other"}}')).toThrow('must be "replace" or "base"');
  });

  test("routes relative agent coding-tool calls through the active scope", async () => {
    const base = await mkdtemp(path.join(tmpdir(), "materia-base-"));
    const branch = await mkdtemp(path.join(tmpdir(), "materia-branch-"));
    const state = scopedState(base);
    activateUtilityScopeTransition(state, { kind: "replace", scope: { id: "scope:branch", cwd: branch } });

    const readEvent = { type: "tool_call", toolCallId: "1", toolName: "read", input: { path: "src/a.ts" } } as any;
    routeAgentToolCallToActiveScope(readEvent, state);
    expect(readEvent.input.path).toBe(path.join(branch, "src/a.ts"));

    const bashEvent = { type: "tool_call", toolCallId: "2", toolName: "bash", input: { command: "pwd" } } as any;
    routeAgentToolCallToActiveScope(bashEvent, state);
    expect(bashEvent.input.command).toContain(`cd -- '${branch}' && pwd`);
  });
});
