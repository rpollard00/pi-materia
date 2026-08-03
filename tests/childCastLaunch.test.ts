import { describe, expect, test } from "bun:test";
import { waitForChildCastTerminal } from "../src/runtime/childCastLaunch.js";

describe("child cast launch lifetime", () => {
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
