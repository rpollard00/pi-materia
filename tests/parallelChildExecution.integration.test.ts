import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";
import { createExecutionScope, createBaseExecutionScope } from "../src/domain/executionScope.js";
import { createPiChildCastRunner } from "../src/infrastructure/index.js";
import { ParallelLoopDispatcher } from "../src/runtime/parallelDispatcher.js";
import type { MateriaCastState } from "../src/types.js";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

interface FixtureMessage {
  kind: string;
  phase?: string;
  laneId?: string;
  stage?: string;
  position?: number;
  workItemIndex?: number;
  occurredAt?: number;
  endedAt?: number;
  message?: string;
}

type FixtureEvent = FixtureMessage & { receivedAt: number };

interface BarrierFixture {
  port: number;
  events: FixtureEvent[];
  firstPairEntered: Promise<void>;
  allChildrenTerminal: Promise<void>;
  childFailure: Promise<string>;
  releaseFirstPair(): void;
  diagnostics(): string;
  close(): Promise<void>;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>((done) => { resolve = done; }), resolve };
}

async function startBarrierFixture(): Promise<BarrierFixture> {
  const server = createServer();
  const events: FixtureEvent[] = [];
  const firstPair = deferred<void>();
  const allChildrenTerminal = deferred<void>();
  const childFailure = deferred<string>();
  const terminalLanes = new Set<string>();
  const pendingPair = new Map<string, Socket>();
  const sockets = new Set<Socket>();
  let pairReleased = false;
  let closed = false;

  const recordFailure = (message: string): void => {
    events.push({ kind: "error", phase: "terminal-coordination", message, receivedAt: Date.now() });
    childFailure.resolve(message);
  };
  const respond = (socket: Socket, kind = "continue", message?: string): void => {
    if (!socket.destroyed) socket.write(`${JSON.stringify({ kind, ...(message ? { message } : {}) })}\n`);
  };

  server.on("connection", (socket) => {
    sockets.add(socket);
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      while (true) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let message: FixtureMessage;
        try {
          message = JSON.parse(line) as FixtureMessage;
        } catch {
          recordFailure(`fixture received malformed message: ${line}`);
          respond(socket, "fail", "malformed fixture message");
          continue;
        }
        events.push({ ...message, receivedAt: Date.now() });
        if (message.kind === "error") {
          recordFailure(`${message.phase ?? "unknown"}/${message.laneId ?? "unknown"}: ${message.message ?? "child fixture error"}`);
          respond(socket);
          continue;
        }
        if (message.kind === "terminal" && message.laneId) {
          terminalLanes.add(message.laneId);
          if (terminalLanes.size === 3) allChildrenTerminal.resolve();
        }
        if (message.kind === "stage" && message.position === 1 && !pairReleased) {
          if (!message.laneId) {
            recordFailure("socket-execution stage is missing its lane id");
            respond(socket, "fail", "lane id is required");
            continue;
          }
          if (pendingPair.has(message.laneId)) {
            recordFailure(`lane ${message.laneId} announced its barrier stage twice`);
            respond(socket, "fail", "duplicate barrier stage");
            continue;
          }
          pendingPair.set(message.laneId, socket);
          if (pendingPair.size === 2) firstPair.resolve();
          continue;
        }
        respond(socket);
      }
    });
    socket.on("error", (error) => {
      if (!closed) recordFailure(`fixture socket error: ${error.message}`);
    });
    socket.on("close", () => {
      sockets.delete(socket);
      for (const [laneId, pending] of pendingPair) {
        if (pending === socket) pendingPair.delete(laneId);
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture server did not expose a TCP port");

  return {
    port: address.port,
    events,
    firstPairEntered: firstPair.promise,
    allChildrenTerminal: allChildrenTerminal.promise,
    childFailure: childFailure.promise,
    releaseFirstPair() {
      if (pairReleased) return;
      pairReleased = true;
      for (const socket of pendingPair.values()) respond(socket);
      pendingPair.clear();
    },
    diagnostics() {
      return JSON.stringify(events, null, 2);
    },
    async close() {
      closed = true;
      pairReleased = true;
      for (const socket of pendingPair.values()) respond(socket);
      pendingPair.clear();
      for (const socket of sockets) socket.destroy();
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function integrationState(root: string, port: number): MateriaCastState {
  const baseScope = createExecutionScope({
    ...createBaseExecutionScope("cast-integration", root),
    state: { fixture: "concurrent-child-socket" },
    exports: {},
  });
  const context = JSON.stringify({ host: "127.0.0.1", port });
  const workItems = Array.from({ length: 6 }, (_, index) => ({
    title: `fixture-item-${index}`,
    context,
  }));
  const pipeline = {
    entry: "Prelude",
    sockets: {
      Prelude: { materia: "Spawn-JJ-Workspace", edges: [{ when: "always", to: "Loop-A" }] },
      "Loop-A": { materia: "Build", edges: [{ when: "always", to: "Loop-B" }] },
      "Loop-B": { materia: "Auto-Eval", edges: [{ when: "always", to: "Loop-A" }] },
    },
    loops: {
      build: {
        sockets: ["Loop-A", "Loop-B"],
        consumes: { from: "Prelude", output: "workItems" },
        iterator: { items: "state.workItems", as: "workItem", cursor: "workItemIndex", done: "end" },
        parallel: { maxConcurrency: 2 },
      },
    },
  } as any;

  return {
    version: 2,
    active: true,
    castId: "cast-integration",
    request: "run synchronized fixture child sockets",
    configSource: "integration-test",
    configHash: "integration-config",
    cwd: root,
    baseScope,
    activeScope: baseScope,
    branchScopes: {},
    runDir: path.join(root, "parent-run"),
    artifactRoot: path.join(root, "parent-artifacts"),
    phase: "Loop-A",
    currentSocketId: "Loop-A",
    awaitingResponse: false,
    socketState: "idle",
    startedAt: 1,
    updatedAt: 1,
    parallelRuns: {},
    data: {
      workItems,
      parallelPlan: {
        version: 1,
        planId: "integration-plan",
        workItemCount: workItems.length,
        streams: [
          { laneId: "lane-a", name: "fixture-a", streamIndex: 0, workItemIndexes: [0, 1] },
          { laneId: "lane-b", name: "fixture-b", streamIndex: 1, workItemIndexes: [2, 3] },
          { laneId: "lane-c", name: "fixture-c", streamIndex: 2, workItemIndexes: [4, 5] },
        ],
      },
    },
    cursors: {},
    visits: {},
    taskAttempts: {},
    edgeTraversals: {},
    runState: {
      runId: "integration-run",
      startedAt: 1,
      runDir: path.join(root, "parent-run"),
      eventsFile: path.join(root, "parent-run", "events.jsonl"),
      usageFile: path.join(root, "parent-run", "usage.json"),
      usage: {
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        byMateria: {},
        bySocket: {},
        byTask: {},
        byAttempt: {},
      },
      budgetWarned: false,
    },
    pipeline,
  } as MateriaCastState;
}

function assertWithDiagnostics(condition: unknown, message: string, fixture: BarrierFixture): asserts condition {
  if (!condition) throw new Error(`${message}\nFixture diagnostics:\n${fixture.diagnostics()}`);
}

function laneEvents(fixture: BarrierFixture, laneId: string): FixtureEvent[] {
  return fixture.events.filter((event) => event.laneId === laneId);
}

function eventIndex(fixture: BarrierFixture, predicate: (event: FixtureEvent) => boolean): number {
  return fixture.events.findIndex(predicate);
}

describe("production parallel coordinator and child socket execution", () => {
  test("runs synchronized child branch programs concurrently and refills the bounded queue", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pi-materia-parallel-child-integration-"));
    const fixture = await startBarrierFixture();
    const state = integrationState(root, fixture.port);
    const childProgram = fileURLToPath(new URL("./fixtures/concurrentChildSocket.mjs", import.meta.url));

    let pairStageObserved!: () => void;
    const pairStage = new Promise<void>((resolve) => { pairStageObserved = resolve; });
    const runCompleted = deferred<void>();
    let pairStageResolved = false;
    const childRunner = createPiChildCastRunner({
      executable: childProgram,
      extensionPath: "/fixture/does-not-load-an-extension.js",
      now: () => Date.now(),
    });
    const dispatcher = new ParallelLoopDispatcher({
      children: childRunner,
      state: { saveCastState: () => undefined },
      onProgressChange: (run) => {
        if (run.phase === "completed") runCompleted.resolve();
        const first = run.lanes["lane-a"];
        const second = run.lanes["lane-b"];
        if (!pairStageResolved && first?.status === "running" && second?.status === "running"
          && first.progress.position >= 1 && second.progress.position >= 1
          && first.activeStage && second.activeStage) {
          pairStageResolved = true;
          pairStageObserved();
        }
      },
    } as any);

    const dispatchPromise = dispatcher.dispatch({
      pi: {} as any,
      ctx: { ui: { notify: () => undefined } } as any,
      state,
      socket: {} as any,
      loopId: "build",
      config: { maxConcurrency: 2 },
    });
    try {
      const beforePair = await Promise.race([
        fixture.firstPairEntered.then(() => "pair" as const),
        fixture.childFailure.then((message) => { throw new Error(`child fixture failed before its barrier: ${message}\n${fixture.diagnostics()}`); }),
        dispatchPromise.then(() => new Promise<never>(() => undefined), (error: unknown) => {
          throw new Error(`dispatch phase failed: ${error instanceof Error ? error.message : String(error)}\nParent state:\n${JSON.stringify(state.parallelRuns)}\nFixture diagnostics:\n${fixture.diagnostics()}`);
        }),
      ]);
      expect(beforePair).toBe("pair");
      await Promise.race([
        pairStage,
        fixture.childFailure.then((message) => { throw new Error(`child progress did not reach the synchronized pair: ${message}\n${fixture.diagnostics()}`); }),
      ]);

      const runBeforeRelease = state.parallelRuns?.build;
      assertWithDiagnostics(runBeforeRelease !== undefined, "parallel run was not persisted before the child barrier", fixture);
      expect(runBeforeRelease.lanes["lane-a"]?.status).toBe("running");
      expect(runBeforeRelease.lanes["lane-b"]?.status).toBe("running");
      expect(runBeforeRelease.lanes["lane-c"]?.status).toBe("queued");
      expect(fixture.events.some((event) => event.kind === "terminal")).toBe(false);

      const firstPairStages = fixture.events.filter((event) => event.kind === "stage" && event.position === 1);
      assertWithDiagnostics(firstPairStages.map((event) => event.laneId).sort().join(",") === "lane-a,lane-b", "exactly the two bounded slots should reach the branch barrier first", fixture);
      expect(firstPairStages.every((event) => event.phase === "socket-execution")).toBe(true);
      expect(firstPairStages.every((event) => typeof event.occurredAt === "number")).toBe(true);
      expect(runBeforeRelease.lanes["lane-a"]?.activeStage?.label).toBeTruthy();
      expect(runBeforeRelease.lanes["lane-b"]?.activeStage?.label).toBeTruthy();
      expect(runBeforeRelease.lanes["lane-a"]?.progress.total).toBe(4);
      expect(runBeforeRelease.lanes["lane-b"]?.progress.total).toBe(4);

      for (const laneId of ["lane-a", "lane-b"]) {
        const childCastId = runBeforeRelease.lanes[laneId]!.childCastId!;
        const invocation = childRunner.getLaunchInvocation(childCastId);
        assertWithDiagnostics(invocation !== undefined, `production child runner did not retain launch invocation for ${laneId}`, fixture);
        expect(invocation.args).toContain("--mode");
        expect(invocation.args).toContain("json");
      }

      fixture.releaseFirstPair();
      await Promise.race([
        fixture.allChildrenTerminal,
        fixture.childFailure.then((message) => { throw new Error(`child fixture failed after the first pair barrier: ${message}\n${fixture.diagnostics()}`); }),
      ]);
      await runCompleted.promise;
      await dispatchPromise;

      const completedRun = state.parallelRuns?.build;
      assertWithDiagnostics(completedRun !== undefined, "completed parallel run disappeared from parent state", fixture);
      expect(completedRun.phase).toBe("completed");
      expect(completedRun.fanInPhase).toBe("accepted");
      expect(Object.values(completedRun.lanes).map((lane) => lane.status)).toEqual(["accepted", "accepted", "accepted"]);

      const firstPairTerminalIndexes = ["lane-a", "lane-b"].map((laneId) => eventIndex(fixture, (event) => event.kind === "terminal" && event.laneId === laneId));
      const thirdEntryIndex = eventIndex(fixture, (event) => event.kind === "stage" && event.laneId === "lane-c" && event.position === 1);
      assertWithDiagnostics(firstPairTerminalIndexes.every((index) => index >= 0), "the first two child bodies did not reach terminal coordination", fixture);
      assertWithDiagnostics(thirdEntryIndex > Math.min(...firstPairTerminalIndexes), "the third lane entered only after a bounded slot was terminal", fixture);

      const firstA = fixture.events.find((event) => event.kind === "stage" && event.laneId === "lane-a" && event.position === 1)!;
      const firstB = fixture.events.find((event) => event.kind === "stage" && event.laneId === "lane-b" && event.position === 1)!;
      const terminalA = fixture.events.find((event) => event.kind === "terminal" && event.laneId === "lane-a")!;
      const terminalB = fixture.events.find((event) => event.kind === "terminal" && event.laneId === "lane-b")!;
      assertWithDiagnostics(firstA.occurredAt! <= terminalB.endedAt! && firstB.occurredAt! <= terminalA.endedAt!, "the first two branch stage intervals did not overlap", fixture);

      for (const laneId of ["lane-a", "lane-b", "lane-c"]) {
        const events = laneEvents(fixture, laneId);
        const stages = events.filter((event) => event.kind === "stage");
        expect(events[0]?.kind).toBe("connected");
        expect(stages.map((event) => event.position)).toEqual([0, 1, 2, 3, 4]);
        expect(stages[0]?.phase).toBe("prelude");
        expect(stages.slice(1).every((event) => event.phase === "socket-execution")).toBe(true);
        expect(events.at(-1)?.kind).toBe("terminal");
        expect(events.at(-1)?.phase).toBe("terminal-coordination");
      }

      const allStageSocketIds = fixture.events
        .filter((event) => event.kind === "stage" && event.position !== undefined)
        .map((event) => event.stage);
      expect(allStageSocketIds.every((socketId) => typeof socketId === "string" && /^Socket-[1-3]$/.test(socketId!))).toBe(true);

      for (const laneId of ["lane-a", "lane-b", "lane-c"]) {
        const session = completedRun.lanes[laneId]!.childSession!;
        const launchSpec = JSON.parse(await readFile(path.join(session.runDirectory, "child-launch.json"), "utf8"));
        expect(launchSpec.identity.laneId).toBe(laneId);
        expect(launchSpec.compiledLoadout.initialData.parallelLane.laneId).toBe(laneId);
        const stdoutArtifact = await readFile(path.join(session.artifactRoot, "child-stdout.jsonl"), "utf8");
        expect(stdoutArtifact).toContain("pi_materia_child_progress");
        expect(stdoutArtifact).toContain("pi_materia_child_terminal");
      }
    } finally {
      fixture.releaseFirstPair();
      await dispatchPromise.catch(() => undefined);
      await fixture.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
