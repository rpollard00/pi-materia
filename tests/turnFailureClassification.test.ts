import { describe, expect, test } from "bun:test";
import { evaluateContextErrorRecovery } from "../src/application/contextErrorRecoveryPolicy.js";
import { classifyRecoverableTurnFailure, classifyTurnFailure, ensureRecoveryAllowance } from "../src/application/recoveryPolicy.js";

describe("turn failure classification", () => {
  test("classifies plain WebSocket transport failures as transient", () => {
    expect(classifyTurnFailure(new Error("WebSocket error"))).toBe("transient_transport");
    expect(classifyTurnFailure(new Error('Pi agent turn failed for socket "Build": WebSocket error'))).toBe("transient_transport");
  });

  test("classifies stream-ended-without-finish-reason as transient_transport", () => {
    expect(classifyTurnFailure(new Error("Stream ended without finish_reason"))).toBe("transient_transport");
    expect(classifyTurnFailure(new Error('Pi agent turn failed for socket "Build": Stream ended without finish_reason'))).toBe("transient_transport");
    // Also match dashed variant
    expect(classifyTurnFailure(new Error("Stream ended without finish-reason"))).toBe("transient_transport");
  });

  test("stream-ended transport failures are not recoverable same-socket failures", () => {
    const error = new Error("Stream ended without finish_reason");
    expect(classifyTurnFailure(error, { allowGenericTurnFailure: true })).toBe("transient_transport");
    expect(classifyRecoverableTurnFailure(error, { allowGenericTurnFailure: true })).toBeUndefined();
  });

  test("stream-ended classification does not mask structured provider errors", () => {
    // Stream-ended text appears before a structured provider error —
    // the end-of-message anchor prevents transient_transport.
    const serverAfter = new Error('Stream ended without finish_reason Codex error: {"type":"error","error":{"type":"server_error","code":"server_error","message":"Internal error"}}');
    expect(classifyTurnFailure(serverAfter)).toBeUndefined();

    // Structured provider error appears before stream-ended text —
    // the provider error payload is detected anywhere in the message and
    // stream-ended classification is refused, so the structured error
    // falls through for recovery or terminal handling.
    const serverBefore = new Error('Codex error: {"type":"error","error":{"type":"server_error","code":"server_error"}} Stream ended without finish_reason');
    expect(classifyTurnFailure(serverBefore)).toBeUndefined();

    // Context-length wrapped in stream text still wins (checked first)
    const ctxAfter = new Error('Stream ended without finish_reason Codex error: {"type":"error","error":{"type":"invalid_request_error","code":"context_length_exceeded","message":"Your input exceeds the context window."}}');
    expect(classifyTurnFailure(ctxAfter)).toBe("context_window");

    // Context-length before stream-ended text also wins (checked first)
    const ctxBefore = new Error('Codex error: {"type":"error","error":{"type":"invalid_request_error","code":"context_length_exceeded"}} Stream ended without finish_reason');
    expect(classifyTurnFailure(ctxBefore)).toBe("context_window");
  });

  test("context-window signals wrapped in WebSocket text remain context-window failures", () => {
    const errorMessage = 'Error: WebSocket closed 1000 Error: Codex error: {"type":"error","error":{"type":"invalid_request_error","code":"context_length_exceeded","message":"Your input exceeds the context window of this model."}}';
    expect(classifyTurnFailure(new Error(errorMessage))).toBe("context_window");
    expect(classifyTurnFailure(new Error(errorMessage), { allowGenericTurnFailure: true })).toBe("context_window");
    expect(classifyRecoverableTurnFailure(new Error(errorMessage), { allowGenericTurnFailure: true })).toBe("context_window");
  });

  test("plain transport failures stay transient and are not recoverable same-socket failures", () => {
    const error = new Error("WebSocket error");
    expect(classifyTurnFailure(error, { allowGenericTurnFailure: true })).toBe("transient_transport");
    expect(classifyRecoverableTurnFailure(error, { allowGenericTurnFailure: true })).toBeUndefined();
  });

  test("Codex server errors are transient policy decisions, not context-window failures", () => {
    const error = new Error('Codex error: {"type":"error","error":{"type":"server_error","code":"server_error","message":"An error occurred while processing your request. You can retry your request, or contact us through our help center at help.openai.com if the error persists. Please include the request ID 06c12916-6464-4199-b4b7-53055ee0111a in your message.","param":null},"sequence_number":2}');
    const decision = evaluateContextErrorRecovery(error);
    expect(decision.action).toBe("retry_without_compaction");
    expect(decision.transientProviderSignal).toBe(true);
    expect(decision.strongContextSignal).toBe(false);
    expect(decision.provider.type).toBe("server_error");
    expect(classifyTurnFailure(error)).toBeUndefined();
  });

  test("Codex context length errors normalize as strong context policy decisions", () => {
    const error = new Error('Codex error: {"type":"error","error":{"type":"invalid_request_error","code":"context_length_exceeded","message":"Your input exceeds the context window of this model. Please adjust your input and try again.","param":"input"},"sequence_number":2}');
    const decision = evaluateContextErrorRecovery(error);
    expect(decision.action).toBe("compact");
    expect(decision.strongContextSignal).toBe(true);
    expect(decision.transientProviderSignal).toBe(false);
    expect(decision.provider.code).toBe("context_length_exceeded");
    expect(decision.provider.param).toBe("input");
    expect(classifyTurnFailure(error)).toBe("context_window");
  });

  test("transient provider payloads win over context wording in wrappers", () => {
    const error = new Error('Context window recovery failed: Codex error: {"type":"error","error":{"type":"server_error","code":"server_error","message":"An error occurred while processing your request. You can retry your request.","param":null},"sequence_number":2}');
    const decision = evaluateContextErrorRecovery(error);
    expect(decision.action).toBe("retry_without_compaction");
    expect(decision.strongContextSignal).toBe(false);
    expect(classifyTurnFailure(error)).toBeUndefined();
  });

  test("generic turn failure classification requires an explicit safe-retry opt-in", () => {
    const error = new Error("provider auth failed");
    expect(classifyTurnFailure(error)).toBeUndefined();
    expect(classifyRecoverableTurnFailure(error)).toBeUndefined();
    expect(classifyTurnFailure(error, { allowGenericTurnFailure: true })).toBe("turn_failure");
    expect(classifyRecoverableTurnFailure(error, { allowGenericTurnFailure: true })).toBe("turn_failure");
  });

  test("auth, invalid request, and provider errors are not transient transport by default", () => {
    expect(classifyTurnFailure(new Error("provider auth failed"))).toBeUndefined();
    expect(classifyTurnFailure(new Error('WebSocket closed 1000 Error: Codex error: {"type":"error","error":{"type":"invalid_request_error","message":"bad request"}}'))).toBeUndefined();
    expect(classifyTurnFailure(new Error("provider configuration unavailable"))).toBeUndefined();
  });

  test("bash tool timeouts are classified as tool_timeout", () => {
    expect(classifyTurnFailure(new Error('Pi agent turn failed for socket "Build": Command timed out after 120 seconds'))).toBe("tool_timeout");
    expect(classifyRecoverableTurnFailure(new Error('Command timed out after 180 seconds'))).toBe("tool_timeout");
  });

  test("tool-call timeout messages are classified as tool_timeout", () => {
    expect(classifyTurnFailure(new Error("bash command timed out"))).toBe("tool_timeout");
    expect(classifyTurnFailure(new Error("tool call timed out during execution"))).toBe("tool_timeout");
    expect(classifyRecoverableTurnFailure(new Error("bash command timed out"))).toBe("tool_timeout");
  });

  test("utility socket timeout messages are classified as tool_timeout", () => {
    expect(classifyTurnFailure(new Error('Utility command timed out for socket "Build" after 30000ms'))).toBe("tool_timeout");
    expect(classifyRecoverableTurnFailure(new Error('Utility command timed out for socket "Build" after 30000ms'))).toBe("tool_timeout");
  });

  test("tool_timeout is recoverable without allowGenericTurnFailure opt-in", () => {
    const error = new Error("bash command timed out");
    expect(classifyTurnFailure(error)).toBe("tool_timeout");
    expect(classifyRecoverableTurnFailure(error)).toBe("tool_timeout");
    expect(classifyRecoverableTurnFailure(error, { allowGenericTurnFailure: false })).toBe("tool_timeout");
    expect(classifyRecoverableTurnFailure(error, { allowGenericTurnFailure: true })).toBe("tool_timeout");
  });

  test("tool_timeout classification is not confused by unrelated timeout mentions", () => {
    // "timeout" alone without the tool/command pattern should not match
    expect(classifyTurnFailure(new Error("connection timeout exceeded"))).toBeUndefined();
    expect(classifyTurnFailure(new Error("request took too long"))).toBeUndefined();
  });

  test("ensureRecoveryAllowance creates budget of 3 for tool_timeout reason", () => {
    const state = { recoveryAllowances: {} } as any;
    const allowance = ensureRecoveryAllowance(state, "key-1", { reason: "tool_timeout" });
    expect(allowance).toEqual({ originalMaxAttempts: 3, effectiveMaxAttempts: 3, reviveCount: 0 });
  });

  test("ensureRecoveryAllowance uses default budget of 1 without tool_timeout reason", () => {
    const state = { recoveryAllowances: {} } as any;
    const allowance = ensureRecoveryAllowance(state, "key-1");
    expect(allowance).toEqual({ originalMaxAttempts: 1, effectiveMaxAttempts: 1, reviveCount: 0 });
    const ctxAllowance = ensureRecoveryAllowance(state, "key-2", { reason: "context_window" });
    expect(ctxAllowance).toEqual({ originalMaxAttempts: 1, effectiveMaxAttempts: 1, reviveCount: 0 });
    const turnAllowance = ensureRecoveryAllowance(state, "key-3", { reason: "turn_failure" });
    expect(turnAllowance).toEqual({ originalMaxAttempts: 1, effectiveMaxAttempts: 1, reviveCount: 0 });
  });

  test("ensureRecoveryAllowance upgrades existing allowance to timeout budget when reason is tool_timeout", () => {
    const state = { recoveryAllowances: {} } as any;
    // Create with default budget
    const original = ensureRecoveryAllowance(state, "key-1");
    expect(original).toEqual({ originalMaxAttempts: 1, effectiveMaxAttempts: 1, reviveCount: 0 });
    // Upgrade to timeout budget
    const upgraded = ensureRecoveryAllowance(state, "key-1", { reason: "tool_timeout" });
    expect(upgraded).toEqual({ originalMaxAttempts: 3, effectiveMaxAttempts: 3, reviveCount: 0 });
    expect(upgraded).toBe(original); // same object reference
  });

  test("ensureRecoveryAllowance does not downgrade an already-higher budget for tool_timeout", () => {
    const state = { recoveryAllowances: { "key-1": { originalMaxAttempts: 5, effectiveMaxAttempts: 7, reviveCount: 2 } } } as any;
    const allowance = ensureRecoveryAllowance(state, "key-1", { reason: "tool_timeout" });
    expect(allowance).toEqual({ originalMaxAttempts: 5, effectiveMaxAttempts: 7, reviveCount: 2 });
  });

  test("ensureRecoveryAllowance does not upgrade non-timeout reasons", () => {
    const state = { recoveryAllowances: { "key-1": { originalMaxAttempts: 1, effectiveMaxAttempts: 1, reviveCount: 0 } } } as any;
    const allowance = ensureRecoveryAllowance(state, "key-1", { reason: "context_window" });
    expect(allowance).toEqual({ originalMaxAttempts: 1, effectiveMaxAttempts: 1, reviveCount: 0 });
  });
});
