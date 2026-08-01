import { describe, expect, test } from "bun:test";
import { createFakeChildCastRunner, type ChildCastIdentity, type StartChildCastInput } from "../src/application/index.js";

function startInput(identity: ChildCastIdentity = { childCastId: "child-1", parentCastId: "parent-1", loopId: "build", laneId: "lane-1" }): StartChildCastInput {
  return {
    identity,
    request: "implement the assigned work item",
    cwd: "/repo/.pi/parallel/lane-1",
    compiledLoadout: {
      childLoadoutId: "parallel-child-build-lane-1",
      loadout: { entry: "Socket-1", sockets: {} },
      initialData: { workItems: [{ title: "one", context: "context" }] },
      loopId: identity.loopId,
      laneId: identity.laneId,
    },
    paths: {
      sessionPath: "/repo/.pi/parallel/lane-1/session.jsonl",
      artifactRoot: "/repo/.pi/parallel/lane-1/artifacts",
      runDirectory: "/repo/.pi/parallel/lane-1/run",
    },
  };
}

describe("application child cast runner port", () => {
  test("starts and observes isolated child DTOs without exposing runtime objects", async () => {
    let now = 100;
    const runner = createFakeChildCastRunner({ now: () => now++ });
    const input = startInput();
    const started = await runner.start(input);

    expect(started.childCastId).toBe("child-1");
    expect(started.snapshot.status).toBe("running");
    expect(started.snapshot.identity).toEqual(input.identity);
    expect(started.snapshot.cwd).toBe(input.cwd);
    expect(started.snapshot.compiledLoadout.childLoadoutId).toBe("parallel-child-build-lane-1");
    expect(started.snapshot.paths.artifactRoot).toContain("artifacts");
    expect(started.snapshot.accepted).toBe(false);
    expect(started.snapshot.usage.tokens.total).toBe(0);

    runner.emit("child-1", { type: "socket_output", socketId: "Socket-1", payload: { text: "done" } });
    const observation = await runner.observe({ childCastId: "child-1", afterSequence: 1 });
    expect(observation?.events.map((event) => event.type)).toEqual(["socket_output"]);
    expect(observation?.snapshot.events).toHaveLength(2);
  });

  test("streams events, terminal result, and diagnostics deterministically", async () => {
    const runner = createFakeChildCastRunner({ now: () => 10 });
    await runner.start(startInput());
    const events: string[] = [];
    const terminals: string[] = [];
    runner.subscribe({ childCastId: "child-1", afterSequence: 1 }, {
      onEvent: (event) => events.push(event.type),
      onTerminal: (result) => terminals.push(result.status),
    });

    runner.addDiagnostic("child-1", { code: "child_warning", message: "bounded warning", severity: "warning" });
    runner.complete("child-1", { accepted: true, message: "accepted" });
    await runner.drain();

    const snapshot = runner.getSnapshot("child-1")!;
    expect(events).toEqual(["diagnostic", "terminal"]);
    expect(terminals).toEqual(["succeeded"]);
    expect(snapshot.status).toBe("succeeded");
    expect(snapshot.accepted).toBe(true);
    expect(snapshot.terminalResult).toMatchObject({ status: "succeeded", accepted: true, message: "accepted" });
    expect(snapshot.diagnostics).toHaveLength(1);
  });

  test("resumes failed children and makes abort idempotent", async () => {
    let now = 20;
    const runner = createFakeChildCastRunner({ now: () => now++ });
    await runner.start(startInput());
    runner.fail("child-1", { error: "child failed" });

    const resumed = await runner.resume({ childCastId: "child-1" });
    expect(resumed.snapshot.status).toBe("running");
    expect(resumed.snapshot.attempt).toBe(2);
    expect(resumed.snapshot.terminalResult).toBeUndefined();

    const aborted = await runner.abort({ childCastId: "child-1", reason: "parent cancelled" });
    expect(aborted).toMatchObject({ status: "aborted", aborted: true });
    expect(aborted.snapshot?.terminalResult).toMatchObject({ status: "interrupted", accepted: false, abortReason: "parent cancelled" });

    const repeated = await runner.abort({ childCastId: "child-1", reason: "parent cancelled again" });
    expect(repeated).toMatchObject({ status: "already_terminal", aborted: false });
    expect(repeated.snapshot?.terminalResult?.abortReason).toBe("parent cancelled");
  });
});
