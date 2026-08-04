import { describe, expect, test } from "bun:test";
import { waitForChildCastTerminal } from "../src/runtime/childCastLaunch.js";
import {
  beginChildUsageCheckpointEmission,
  emitChildUsageCheckpoint,
} from "../src/runtime/childUsageCheckpoints.js";

describe("child cast launch lifetime", () => {
  test("emits only changed canonical finite usage checkpoints", () => {
    const lines: string[] = [];
    const stop = beginChildUsageCheckpointEmission((line) => { lines.push(line); });
    const usage = {
      tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10, providerMetadata: "discard" },
      cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1, providerMetadata: "discard" },
      bySocket: { secret: true },
    };

    expect(emitChildUsageCheckpoint(usage)).toBe(true);
    expect(emitChildUsageCheckpoint(structuredClone(usage))).toBe(false);
    expect(emitChildUsageCheckpoint({ ...usage, tokens: { ...usage.tokens, total: Number.NaN } })).toBe(false);
    stop();
    expect(emitChildUsageCheckpoint(usage)).toBe(false);

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual({
      type: "pi_materia_child_usage",
      usage: {
        tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
        cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 },
      },
    });
  });

  test("waits through the idle gap before deferred socket advancement", async () => {
    let idleCalls = 0;
    let state: { active: boolean } = { active: true };

    const terminal = await waitForChildCastTerminal(
      {
        waitForIdle: async () => {
          idleCalls += 1;
          if (idleCalls === 2) state = { active: false };
        },
      },
      () => state as any,
    );

    expect(idleCalls).toBe(2);
    expect(terminal).toEqual({ active: false });
  });
});
