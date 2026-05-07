import { describe, expect, test } from "bun:test";
import { classifyTurnFailure } from "../src/native.js";

describe("turn failure classification", () => {
  test("classifies plain WebSocket transport failures as transient", () => {
    expect(classifyTurnFailure(new Error("WebSocket error"))).toBe("transient_transport");
    expect(classifyTurnFailure(new Error('Pi agent turn failed for node "Build": WebSocket error'))).toBe("transient_transport");
  });

  test("context-window signals wrapped in WebSocket text remain context-window failures", () => {
    const errorMessage = 'Error: WebSocket closed 1000 Error: Codex error: {"type":"error","error":{"type":"invalid_request_error","code":"context_length_exceeded","message":"Your input exceeds the context window of this model."}}';
    expect(classifyTurnFailure(new Error(errorMessage))).toBe("context_window");
  });

  test("auth, invalid request, and provider errors are not transient transport", () => {
    expect(classifyTurnFailure(new Error("provider auth failed"))).toBeUndefined();
    expect(classifyTurnFailure(new Error('WebSocket closed 1000 Error: Codex error: {"type":"error","error":{"type":"invalid_request_error","message":"bad request"}}'))).toBeUndefined();
    expect(classifyTurnFailure(new Error("provider configuration unavailable"))).toBeUndefined();
  });
});
