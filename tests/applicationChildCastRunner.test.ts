import { describe, expect, test } from "bun:test";
import { createChildCastRecoveryDescriptor, createFakeChildCastRunner, type ChildCastIdentity, type StartChildCastInput } from "../src/application/index.js";

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
    expect(started.snapshot.operation).toBe("start");
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

  test("resumes failed or unaccepted children and makes abort idempotent", async () => {
    let now = 20;
    const runner = createFakeChildCastRunner({ now: () => now++ });
    await runner.start(startInput());
    runner.complete("child-1", { accepted: false, message: "no accepted terminal result" });

    const resumed = await runner.resume({ childCastId: "child-1" });
    expect(resumed.snapshot.status).toBe("running");
    expect(resumed.snapshot.operation).toBe("revive");
    expect(resumed.snapshot.attempt).toBe(2);
    expect(resumed.snapshot.terminalResult).toBeUndefined();

    const aborted = await runner.abort({ childCastId: "child-1", reason: "parent cancelled" });
    expect(aborted).toMatchObject({ status: "aborted", aborted: true });
    expect(aborted.snapshot?.terminalResult).toMatchObject({ status: "interrupted", accepted: false, abortReason: "parent cancelled" });

    const repeated = await runner.abort({ childCastId: "child-1", reason: "parent cancelled again" });
    expect(repeated).toMatchObject({ status: "already_terminal", aborted: false });
    expect(repeated.snapshot?.terminalResult?.abortReason).toBe("parent cancelled");
  });

  test("revives and recasts from a validated descriptor while retaining identity and cumulative usage", async () => {
    const executionScope = { id: "branch-scope", cwd: "/repo/.pi/parallel/lane-1", state: { branch: "lane-1" }, exports: {} };
    const runner = createFakeChildCastRunner({ now: () => 30 });
    const started = await runner.start({ ...startInput(), executionScope });
    runner.fail("child-1", {
      error: "first attempt failed",
      usage: {
        tokens: { input: 3, output: 4, cacheRead: 0, cacheWrite: 0, total: 7 },
        cost: { input: 0.3, output: 0.4, cacheRead: 0, cacheWrite: 0, total: 0.7 },
      },
    });

    const descriptor = createChildCastRecoveryDescriptor(runner.getSnapshot("child-1")!);
    const revived = await runner.revive({ childCastId: "child-1", recovery: descriptor });
    expect(revived.snapshot).toMatchObject({
      operation: "revive",
      attempt: 2,
      identity: started.snapshot.identity,
      paths: started.snapshot.paths,
      executionScope,
      usage: descriptor.usageBaseline,
    });
    expect(revived.snapshot.events.at(-1)).toMatchObject({ type: "recovery", payload: { operation: "revive", attempt: 2 } });

    runner.complete("child-1", {
      accepted: false,
      usage: {
        tokens: { input: 4, output: 5, cacheRead: 0, cacheWrite: 0, total: 9 },
        cost: { input: 0.4, output: 0.5, cacheRead: 0, cacheWrite: 0, total: 0.9 },
      },
    });
    const recast = await runner.recast({ recovery: createChildCastRecoveryDescriptor(runner.getSnapshot("child-1")!) });
    expect(recast.snapshot.operation).toBe("recast");
    expect(recast.snapshot.attempt).toBe(3);
    expect(recast.snapshot.usage.tokens.total).toBe(9);
    expect(recast.snapshot.executionScope).toEqual(executionScope);
  });

  test("retains the child session cwd when its active execution scope moved to a workspace", async () => {
    const runner = createFakeChildCastRunner({ now: () => 40 });
    const input = startInput();
    await runner.start(input);
    const workspaceScope = {
      id: "branch-workspace-scope",
      cwd: "/tmp/workspaces/lane-1",
      state: { branch: "lane-1" },
      exports: { workspace: { producer: "spawn", value: { path: "/tmp/workspaces/lane-1" } } },
    };
    runner.complete("child-1", { accepted: false, executionScope: workspaceScope });

    const descriptor = createChildCastRecoveryDescriptor(runner.getSnapshot("child-1")!);
    expect(descriptor.cwd).toBe(input.cwd);
    expect(descriptor.executionScope).toEqual(workspaceScope);

    const revived = await runner.revive({ recovery: descriptor });
    expect(revived.snapshot.cwd).toBe(input.cwd);
    expect(revived.snapshot.executionScope).toEqual(workspaceScope);
  });

  test("rejects explicit recovery while active and after acceptance", async () => {
    const runner = createFakeChildCastRunner();
    const started = await runner.start(startInput());
    const descriptor = createChildCastRecoveryDescriptor(started.snapshot);
    await expect(runner.revive({ recovery: descriptor })).rejects.toThrow(/already active/);

    runner.complete("child-1", { accepted: true });
    await expect(runner.recast({ childCastId: "child-1", recovery: createChildCastRecoveryDescriptor(runner.getSnapshot("child-1")!) })).rejects.toThrow(/accepted and cannot be resumed/);
  });

  test("does not resume an accepted child", async () => {
    const runner = createFakeChildCastRunner();
    await runner.start(startInput());
    runner.complete("child-1", { accepted: true });

    await expect(runner.resume({ childCastId: "child-1" })).rejects.toThrow(/accepted and cannot be resumed/);
  });
});
