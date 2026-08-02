import { EventEmitter } from "node:events";
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
    expect(observed?.events.map((event) => event.type)).toContain("message_start");
    expect(observed?.snapshot.terminalResult).toMatchObject({ status: "succeeded", accepted: true });
    expect(observed?.snapshot.executionScope).toEqual({
      id: "scope-workspace",
      cwd: "/tmp/workspace",
      state: { bookmark: "lane-a" },
      exports: { workspace: { producer: "spawn", value: { name: "ws-a" } } },
    });
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
    child.stderr.write("0123456789abcdef");
    const result = await runner.abort({ childCastId: "child-1", reason: "parent cancelled" });

    expect(child.killed).toBe(true);
    expect(result).toMatchObject({ status: "aborted", aborted: true });
    expect(result.snapshot?.terminalResult).toMatchObject({ status: "interrupted", abortReason: "parent cancelled" });
    expect(result.snapshot?.diagnostics.some((diagnostic) => diagnostic.code === "child_stderr_truncated")).toBe(true);
  });
});
