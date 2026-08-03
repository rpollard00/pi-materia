import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { PassThrough } from "node:stream";
import { describe, expect, test } from "bun:test";
import { createPiChildCastRunner, type PiChildProcessSpawner } from "../src/infrastructure/index.js";
import type { StartChildCastInput } from "../src/application/index.js";

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 999_991;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.killed = true;
    this.signalCode = signal;
    this.stdout.end();
    this.stderr.end();
    queueMicrotask(() => this.emit("close", null, signal));
    return true;
  }

  finish(code = 0): void {
    this.exitCode = code;
    this.stdout.end();
    this.stderr.end();
    queueMicrotask(() => this.emit("close", code, null));
  }
}

function input(): StartChildCastInput {
  return {
    identity: { childCastId: "child-1", parentCastId: "parent-1", loopId: "build", laneId: "lane-a" },
    request: "a request that must not be put in argv",
    cwd: "/tmp/lane-a",
    compiledLoadout: {
      loadout: { entry: "Socket-1", sockets: {} },
      initialData: { workItems: [{ title: "one", context: "ctx" }] },
    },
    paths: {
      sessionPath: "/tmp/lane-a/session.jsonl",
      artifactRoot: "/tmp/lane-a/artifacts",
      runDirectory: "/tmp/lane-a/run",
    },
  };
}

describe("Pi child cast runner", () => {
  test("writes a launch spec, uses restricted resources, and parses partial JSONL", async () => {
    let child!: FakeChild;
    let environment: NodeJS.ProcessEnv | undefined;
    const spawnProcess: PiChildProcessSpawner = (_file, _args, options) => {
      environment = options.env;
      child = new FakeChild();
      return child as never;
    };
    const runner = createPiChildCastRunner({
      spawnProcess,
      extensionPath: "/extension/index.js",
      env: { CHILD_AUTH_TOKEN: "secret" },
      now: () => 100,
    });
    const started = await runner.start(input());
    const terminalResults: unknown[] = [];
    runner.subscribe({ childCastId: "child-1" }, { onTerminal: (result) => { terminalResults.push(result); } });
    const launch = runner.getLaunchInvocation("child-1")!;

    expect(launch.args).toContain("--mode");
    expect(launch.args).toContain("json");
    expect(launch.args).toContain("--no-extensions");
    expect(launch.args).toContain("--no-context-files");
    expect(launch.args.join(" ")).not.toContain(input().request);
    expect(environment?.CHILD_AUTH_TOKEN).toBe("secret");
    expect(JSON.stringify(await runner.readLaunchSpec("child-1"))).not.toContain("CHILD_AUTH_TOKEN");

    child.stdout.write('{"type":"message_start"');
    child.stdout.write(',"payload":{"text":"partial"}}\n{"type":"pi_materia_child_terminal","result":');
    child.stdout.write('{"status":"succeeded","accepted":true,"endedAt":101,"executionScope":{"id":"scope-workspace","cwd":"/tmp/workspace","state":{"bookmark":"lane-a"},"exports":{"workspace":{"producer":"spawn","value":{"name":"ws-a"}}}}}}\n');
    child.finish();
    await new Promise((resolve) => setTimeout(resolve, 10));

    const observed = await runner.observe({ childCastId: started.childCastId, afterSequence: 1 });
    expect(observed?.events.map((event) => event.type)).not.toContain("message_start");
    expect(observed?.events.map((event) => event.type)).not.toContain("terminal");
    expect(observed?.snapshot.terminalResult).toBeUndefined();
    expect(terminalResults).toEqual([expect.objectContaining({ status: "succeeded", accepted: true })]);
    expect(observed?.snapshot.executionScope).toEqual({
      id: "scope-workspace",
      cwd: "/tmp/workspace",
      state: { bookmark: "lane-a" },
      exports: { workspace: { producer: "spawn", value: { name: "ws-a" } } },
    });
  });

  test("retires terminal resources while preserving only failed-lane resume identity", async () => {
    const children: FakeChild[] = [];
    const runner = createPiChildCastRunner({
      spawnProcess: () => {
        const child = new FakeChild();
        children.push(child);
        return child as never;
      },
      extensionPath: "/extension/index.js",
      now: () => 110,
    });

    await runner.start(input());
    children[0]!.stdout.write(`${JSON.stringify({ type: "pi_materia_child_terminal", result: { status: "failed", accepted: false, endedAt: 111, error: "retry" } })}\n`);
    children[0]!.finish(1);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await runner.retire({ childCastId: "child-1", retainForResume: true });

    const retained = await runner.observe({ childCastId: "child-1" });
    expect(retained?.snapshot.status).toBe("failed");
    expect(retained?.snapshot.events).toEqual([]);
    expect(retained?.snapshot.diagnostics).toEqual([]);
    expect(children[0]!.listenerCount("close")).toBe(0);
    expect(children[0]!.stdout.listenerCount("data")).toBe(0);

    const resumed = await runner.resume({ childCastId: "child-1" });
    expect(resumed.snapshot.attempt).toBe(2);
    children[1]!.stdout.write(`${JSON.stringify({ type: "pi_materia_child_terminal", result: { status: "succeeded", accepted: true, endedAt: 112 } })}\n`);
    children[1]!.finish();
    await new Promise((resolve) => setTimeout(resolve, 10));
    await runner.retire({ childCastId: "child-1", retainForResume: false });
    expect(await runner.observe({ childCastId: "child-1" })).toBeUndefined();
    expect(children[1]!.listenerCount("close")).toBe(0);
  });

  test("discards event storms and projects only compact usage telemetry", async () => {
    let child!: FakeChild;
    const runner = createPiChildCastRunner({
      spawnProcess: () => {
        child = new FakeChild();
        return child as never;
      },
      extensionPath: "/extension/index.js",
      now: () => 125,
    });
    await runner.start(input());

    const secret = "SENSITIVE_TOOL_RESULT_DO_NOT_RETAIN";
    const large = secret.repeat(200);
    const noisyTypes = ["message_update", "tool_execution_update", "entry_appended", "message", "turn", "tool", "session"];
    for (let index = 0; index < 700; index++) {
      child.stdout.write(`${JSON.stringify({ type: noisyTypes[index % noisyTypes.length], payload: { content: large, reasoningSignature: secret, arguments: { secret }, result: large }, castState: { secret } })}\n`);
    }
    const messageUsage = [
      { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 10, cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 } },
      { input: 1, output: 1, cacheRead: 1, cacheWrite: 1, totalTokens: 4, cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1, total: 4 } },
      { input: 0, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 1, cost: { input: 0, output: 1, cacheRead: 0, cacheWrite: 0, total: 1 } },
    ];
    for (const usage of messageUsage) {
      child.stdout.write(`${JSON.stringify({
        type: "message_end",
        message: {
          content: large,
          reasoningSignature: secret,
          usage: {
            ...usage,
            cost: { ...usage.cost, toolResult: large },
            reasoningSignature: secret,
          },
        },
        payload: { toolResult: large },
      })}\n`);
    }
    child.stdout.write(`${JSON.stringify({ type: "pi_materia_child_terminal", result: {
      status: "succeeded",
      accepted: true,
      endedAt: 126,
      usage: {
        tokens: { input: 20, output: 20, cacheRead: 20, cacheWrite: 20, total: 80 },
        cost: { input: 2, output: 2, cacheRead: 2, cacheWrite: 2, total: 8 },
      },
    } })}\n`);
    child.finish();
    await new Promise((resolve) => setTimeout(resolve, 20));

    const observation = await runner.observe({ childCastId: "child-1" });
    const projected = observation?.events.filter((event) => event.type === "usage_checkpoint") ?? [];
    expect(projected).toHaveLength(3);
    expect(projected.every((event) => event.payload === undefined)).toBe(true);
    expect(projected.map((event) => event.usage?.tokens.total)).toEqual([10, 14, 15]);
    expect(projected[2]?.usage).toEqual({
      tokens: { input: 2, output: 4, cacheRead: 4, cacheWrite: 5, total: 15 },
      cost: { input: 2, output: 4, cacheRead: 4, cacheWrite: 5, total: 15 },
    });
    // The nested terminal aggregate is authoritative over message checkpoints.
    expect(observation?.snapshot.usage).toEqual({
      tokens: { input: 20, output: 20, cacheRead: 20, cacheWrite: 20, total: 80 },
      cost: { input: 2, output: 2, cacheRead: 2, cacheWrite: 2, total: 8 },
    });
    expect(JSON.stringify(observation?.events)).not.toContain(secret);
    expect(JSON.stringify(observation?.snapshot)).not.toContain(secret);
  });

  test("bounds replay and diagnostics while preserving sequence and late terminal delivery", async () => {
    let child!: FakeChild;
    const runner = createPiChildCastRunner({
      spawnProcess: () => {
        child = new FakeChild();
        return child as never;
      },
      extensionPath: "/extension/index.js",
      maxStdoutBytes: 128,
      maxRetainedEvents: 32,
      maxRetainedDiagnostics: 8,
      now: () => 130,
    });
    await runner.start(input());

    for (let index = 0; index < 3_000; index++) {
      child.stdout.write(`not-json-${index}\n`);
      child.stdout.write(`${JSON.stringify({ type: "message_end", message: { usage: {
        input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      } } })}\n`);
    }
    child.stdout.write(`${JSON.stringify({ type: "pi_materia_child_terminal", result: {
      status: "succeeded",
      accepted: true,
      endedAt: 131,
      usage: { tokens: { input: 3_000, output: 3_000, cacheRead: 0, cacheWrite: 0, total: 6_000 }, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      executionScope: { id: "scope-retained", cwd: "/tmp/lane-a", state: { recovery: "stable" }, exports: {} },
    } })}\n`);
    child.finish();
    await new Promise((resolve) => setTimeout(resolve, 30));

    const observation = await runner.observe({ childCastId: "child-1" });
    expect(observation?.snapshot.events).toHaveLength(32);
    expect(observation?.snapshot.diagnostics).toHaveLength(8);
    expect(observation?.snapshot.events[0]!.sequence).toBeGreaterThan(5_000);
    expect(observation?.snapshot.usage.tokens.total).toBe(6_000);
    expect(observation?.snapshot.executionScope).toMatchObject({ id: "scope-retained", state: { recovery: "stable" } });
    expect(observation?.snapshot.identity).toEqual(input().identity);
    expect(JSON.stringify(observation?.snapshot).length).toBeLessThan(20_000);

    const watermark = observation!.snapshot.events.at(-3)!.sequence;
    const replayed: number[] = [];
    const terminals: string[] = [];
    runner.subscribe({ childCastId: "child-1", afterSequence: watermark }, {
      onEvent: (event) => { replayed.push(event.sequence); },
      onTerminal: (result) => { terminals.push(result.status); },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(replayed).toEqual(observation!.snapshot.events.slice(-2).map((event) => event.sequence));
    expect(terminals).toEqual(["succeeded"]);
    expect((await readFile("/tmp/lane-a/artifacts/child-stdout.jsonl", "utf8")).length).toBeLessThanOrEqual(128);
  });

  test("consumes duplicate terminal markers once without forwarding their payload", async () => {
    let child!: FakeChild;
    const runner = createPiChildCastRunner({
      spawnProcess: () => {
        child = new FakeChild();
        return child as never;
      },
      extensionPath: "/extension/index.js",
      now: () => 140,
    });
    await runner.start(input());
    const terminalResults: unknown[] = [];
    runner.subscribe({ childCastId: "child-1" }, { onTerminal: (result) => { terminalResults.push(result); } });
    const marker = JSON.stringify({ type: "pi_materia_child_terminal", result: {
      status: "succeeded", accepted: true, endedAt: 141,
      output: { content: "FULL_RESULT_ONLY_IN_TERMINAL_CHANNEL" },
    } });
    child.stdout.write(`${marker}\n${marker}\nnot-json-after-terminal\n`);
    child.stderr.write(`${marker}\n`);
    child.finish();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(terminalResults).toHaveLength(1);
    expect(terminalResults[0]).toMatchObject({ output: { content: "FULL_RESULT_ONLY_IN_TERMINAL_CHANNEL" } });
    const observation = await runner.observe({ childCastId: "child-1" });
    expect(observation?.snapshot.terminalResult).toBeUndefined();
    expect(observation?.snapshot.diagnostics).toEqual([]);
    expect(JSON.stringify(observation?.events)).not.toContain("FULL_RESULT_ONLY_IN_TERMINAL_CHANNEL");
    expect(await readFile("/tmp/lane-a/artifacts/child-stdout.jsonl", "utf8")).toContain("FULL_RESULT_ONLY_IN_TERMINAL_CHANNEL");
  });

  test("accepts the terminal marker from stderr when print mode redirects extension stdout", async () => {
    let child!: FakeChild;
    const runner = createPiChildCastRunner({
      spawnProcess: () => {
        child = new FakeChild();
        return child as never;
      },
      extensionPath: "/extension/index.js",
      now: () => 150,
    });
    await runner.start(input());
    const terminalResults: unknown[] = [];
    runner.subscribe({ childCastId: "child-1" }, { onTerminal: (result) => { terminalResults.push(result); } });
    child.stderr.write('{"type":"pi_materia_child_terminal","result":{"status":"succeeded","accepted":true,"endedAt":151}}\n');
    child.finish();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(terminalResults).toEqual([expect.objectContaining({ status: "succeeded", accepted: true })]);
    expect((await runner.observe({ childCastId: "child-1" }))?.snapshot.terminalResult).toBeUndefined();
  });

  test("bounds stderr and terminates the process tree on abort", async () => {
    let child!: FakeChild;
    const runner = createPiChildCastRunner({
      spawnProcess: () => {
        child = new FakeChild();
        return child as never;
      },
      extensionPath: "/extension/index.js",
      maxStderrBytes: 8,
      killGraceMs: 0,
      now: () => 200,
    });
    await runner.start(input());
    const terminalResults: unknown[] = [];
    runner.subscribe({ childCastId: "child-1" }, { onTerminal: (terminal) => { terminalResults.push(terminal); } });
    child.stderr.write("0123456789abcdef");
    const result = await runner.abort({ childCastId: "child-1", reason: "parent cancelled" });

    expect(child.killed).toBe(true);
    expect(result).toMatchObject({ status: "aborted", aborted: true });
    expect(result.snapshot?.terminalResult).toBeUndefined();
    expect(terminalResults).toEqual([expect.objectContaining({ status: "interrupted", abortReason: "parent cancelled" })]);
    expect(result.snapshot?.diagnostics.some((diagnostic) => diagnostic.code === "child_stderr_truncated")).toBe(true);
  });
});
