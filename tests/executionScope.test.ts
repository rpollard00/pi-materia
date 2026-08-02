import { describe, expect, test } from "bun:test";
import {
  baseExecutionScopeId,
  cloneExecutionScope,
  createBaseExecutionScope,
  createExecutionScope,
  MAX_EXECUTION_SCOPE_EXPORT_BYTES,
  MAX_EXECUTION_SCOPE_EXPORTS,
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

  test("preserves export names that are inherited properties on ordinary objects", () => {
    const exports = Object.fromEntries([
      ["__proto__", { producer: "utility", value: { opaque: true } }],
    ]);
    const scope = createExecutionScope({ id: "scope", cwd: "/repo", exports });

    expect(Object.hasOwn(scope.exports, "__proto__")).toBe(true);
    expect(scope.exports.__proto__).toEqual({ producer: "utility", value: { opaque: true } });
  });

  test("bounds producer-owned exports for durable snapshots", () => {
    const tooMany = Object.fromEntries(Array.from({ length: MAX_EXECUTION_SCOPE_EXPORTS + 1 }, (_, index) => [
      `export-${index}`,
      { producer: "utility", value: index },
    ]));
    expect(() => createExecutionScope({ id: "scope", cwd: "/repo", exports: tooMany })).toThrow("at most");
    expect(() => createExecutionScope({
      id: "scope",
      cwd: "/repo",
      exports: { oversized: { producer: "utility", value: "x".repeat(MAX_EXECUTION_SCOPE_EXPORT_BYTES) } },
    })).toThrow("exceeds");
  });
});
