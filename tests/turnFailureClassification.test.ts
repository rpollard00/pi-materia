import { describe, expect, test } from "bun:test";
import { evaluateContextErrorRecovery } from "../src/application/contextErrorRecoveryPolicy.js";
import { classifyRecoverableTurnFailure, classifyTurnFailure } from "../src/application/recoveryPolicy.js";

describe("turn failure classification", () => {
  test("classifies plain WebSocket transport failures as transient", () => {
    expect(classifyTurnFailure(new Error("WebSocket error"))).toBe("transient_transport");
    expect(classifyTurnFailure(new Error('Pi agent turn failed for socket "Build": WebSocket error'))).toBe("transient_transport");
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
});
