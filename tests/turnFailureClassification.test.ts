import { describe, expect, test } from "bun:test";
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
