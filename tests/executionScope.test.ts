import { describe, expect, test } from "bun:test";
import {
  baseExecutionScopeId,
  cloneExecutionScope,
  createBaseExecutionScope,
  createExecutionScope,
} from "../src/domain/executionScope.js";

describe("execution scopes", () => {
  test("creates a stable empty base scope at the project cwd", () => {
    const first = createBaseExecutionScope("cast/one", "/repo/project");
    const restarted = createBaseExecutionScope("cast/one", "/repo/project");

    expect(first).toEqual({
      id: "cast:cast%2Fone:base",
      cwd: "/repo/project",
      state: {},
      exports: {},
    });
    expect(restarted).toEqual(first);
    expect(baseExecutionScopeId("cast/one")).toBe(first.id);
  });

  test("keeps branch-local state and producer-owned exports detached", () => {
    const sourceState = { branch: { attempt: 1 } };
    const sourceExports = { result: { producer: "utility:scope-producer", value: { token: "opaque" } } };
    const scope = createExecutionScope({ id: "scope:branch-a", cwd: "/repo/branch-a", state: sourceState, exports: sourceExports });
    const clone = cloneExecutionScope(scope);

    (sourceState.branch as { attempt: number }).attempt = 2;
    (sourceExports.result.value as { token: string }).token = "changed";

    expect(scope.cwd).toBe("/repo/branch-a");
    expect(scope.state).toEqual({ branch: { attempt: 1 } });
    expect(scope.exports).toEqual({ result: { producer: "utility:scope-producer", value: { token: "opaque" } } });
    expect(clone).toEqual(scope);
    expect(clone.state).not.toBe(scope.state);
    expect(clone.exports).not.toBe(scope.exports);
  });

  test("rejects malformed identities, records, and non-cloneable opaque values", () => {
    expect(() => createBaseExecutionScope("", "/repo")).toThrow("castId must be a non-empty string");
    expect(() => createExecutionScope({ id: "scope", cwd: "", state: {} })).toThrow("execution scope cwd must be a non-empty string");
    expect(() => createExecutionScope({ id: "scope", cwd: "/repo", state: [] as never })).toThrow("state must be a plain object");
    expect(() => createExecutionScope({
      id: "scope",
      cwd: "/repo",
      exports: { bad: { producer: "utility", value: () => undefined } },
    })).toThrow("must be structured-cloneable");
  });
});
