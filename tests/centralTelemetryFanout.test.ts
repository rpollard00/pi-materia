import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import type { Server } from "bun";
import type { CentralConnectedRuntimeConfig } from "../src/central/config/index.js";
import { enrichEvents, createSequenceCounter, type EnrichedEvent } from "../src/domain/eventing.js";
import {
  CENTRAL_TELEMETRY_SINK_ID,
  createCentralConnectedTelemetrySinkResolver,
} from "../src/infrastructure/centralConnectedTelemetrySink.js";
import { NativeEventingRuntime } from "../src/runtime/nativeEventing.js";
import { WebhookSink } from "../src/runtime/webhookSink.js";
import type { MateriaCastState, PiMateriaConfig } from "../src/types.js";

interface RecordedRequest {
  readonly headers: Headers;
  readonly body: unknown;
}

function startServer(
  handler: (request: Request) => Promise<Response> | Response = () => new Response("ok"),
): { server: Server; url: string; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = await request.json().catch(() => undefined);
      requests.push({ headers: request.headers, body });
      return handler(request);
    },
  });
  return { server, url: `http://127.0.0.1:${server.port}`, requests };
}

async function makeState(castId = "cast-central"): Promise<MateriaCastState> {
  const runDir = await mkdtemp(path.join(tmpdir(), "pi-materia-central-fanout-"));
  return {
    version: 2,
    active: true,
    castId,
    request: "test central fan-out",
    configSource: "test",
    configHash: "hash",
    cwd: "/workspace/repository",
    runDir,
    artifactRoot: runDir,
    phase: "Socket-1",
    currentSocketId: "Socket-1",
    currentMateria: "Builder",
    awaitingResponse: true,
    socketState: "awaiting_agent_response",
    startedAt: Date.now(),
    updatedAt: Date.now(),
    data: {},
    cursors: {},
    visits: { "Socket-1": 1 },
    multiTurnRefinements: {},
    taskAttempts: {},
    edgeTraversals: {},
    runState: {
      castId,
      runDir,
      model: "test/model",
      currentSocketId: "Socket-1",
      currentMateria: "Builder",
      lastMessage: "Socket-1",
      attempt: 1,
      usage: { costKind: "tokens", tokenUsage: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 } },
    },
    pipeline: {
      pipeline: "test",
      loadoutName: "test",
      entry: { id: "Socket-1", materia: { materia: "Builder", parse: "text" }, utility: false } as never,
      sockets: new Map(),
    },
  } as MateriaCastState;
}

function event(type: string): EnrichedEvent {
  return enrichEvents(
    [{ type }],
    { castId: "cast-queue", socketId: "Socket-1", materia: "Builder", visit: 1 },
    createSequenceCounter(),
    randomUUID,
  )[0];
}

function connectedConfig(apiUrl: string): CentralConnectedRuntimeConfig {
  return {
    apiUrl,
    requestTimeoutMs: 1_000,
    credentials: { telemetryToken: "telemetry-secret" },
    runtimeId: "runtime-a",
    scope: { tenantId: "tenant-a", repositoryId: "repository-a" },
  };
}

describe("central telemetry fan-out", () => {
  test("registers the central webhook on the existing bus and sends an enriched envelope", async () => {
    const { server, url, requests } = startServer();
    const resolver = createCentralConnectedTelemetrySinkResolver({
      resolveRuntimeConfig: async () => connectedConfig(url),
      createRuntimeId: () => "unused-generated-id",
    });
    const runtime = new NativeEventingRuntime(resolver);
    const state = await makeState();

    try {
      // Explicit eventing is off: central-connected telemetry still uses the
      // same bus, while controller presets and heartbeat remain opt-in.
      const bus = await runtime.initializeCastEventBus(
        { materia: {}, eventing: { enabled: false } } as PiMateriaConfig,
        state,
      );
      expect(bus).toBeDefined();
      expect(bus?.sinks.map((sink) => sink.id)).toEqual(["local-recording", CENTRAL_TELEMETRY_SINK_ID]);

      await runtime.emitLifecycleEvent(state, "lifecycle.cast.started", {
        payload: { phase: "started" },
      });
      await bus?.flush();

      expect(requests).toHaveLength(1);
      expect(requests[0].headers.get("authorization")).toBe("Bearer telemetry-secret");
      const body = requests[0].body as Record<string, unknown>;
      expect(body.runtimeId).toBe("runtime-a");
      expect(body.scope).toEqual({ tenantId: "tenant-a", repositoryId: "repository-a" });
      const sent = (body.events as EnrichedEvent[])[0];
      expect(sent).toMatchObject({
        type: "lifecycle.cast.started",
        castId: state.castId,
        socketId: "lifecycle",
        materia: "pi-materia",
        sequence: 1,
      });
      expect(bus?.outcomes[0].sinks?.find((sink) => sink.sinkId === CENTRAL_TELEMETRY_SINK_ID))
        .toMatchObject({ status: "delivered", statusCode: 200, attempts: 1 });
    } finally {
      runtime.removeEventBus(state.castId);
      server.stop();
    }
  });

  test("contains unavailable configuration and missing credentials without failing cast setup", async () => {
    const state = await makeState("cast-unavailable");
    const unavailable = new NativeEventingRuntime({
      resolve: async () => { throw new Error("secret provider unavailable"); },
    });
    expect(await unavailable.initializeCastEventBus(
      { materia: {}, eventing: { enabled: false } } as PiMateriaConfig,
      state,
    )).toBeUndefined();

    const missingCredential = new NativeEventingRuntime(
      createCentralConnectedTelemetrySinkResolver({
        resolveRuntimeConfig: async () => ({
          apiUrl: "https://central.example.test",
          requestTimeoutMs: 100,
          credentials: {},
        }),
      }),
    );
    expect(await missingCredential.initializeCastEventBus(
      { materia: {}, eventing: { enabled: false } } as PiMateriaConfig,
      state,
    )).toBeUndefined();
  });

  test("bounds queued delivery and records queue/retry diagnostics", async () => {
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let calls = 0;
    const { server, url } = startServer(async () => {
      calls++;
      if (calls === 1) await gate;
      return new Response("ok");
    });

    try {
      const sink = new WebhookSink({
        id: "bounded",
        url,
        bodyTemplate: "passthrough",
        maxQueueSize: 2,
        maxRetries: 0,
      });
      const first = event("first");
      const second = event("second");
      const dropped = event("dropped");
      await sink.deliver(first);
      await sink.deliver(second);
      await sink.deliver(dropped);

      expect(sink.pendingDeliveries).toBe(2);
      expect(sink.droppedEvents).toBe(1);
      releaseFirst();
      await sink.flush();
      expect(calls).toBe(2);
      expect(sink.drainResults().find((result) => result.eventId === dropped.eventId))
        .toMatchObject({ status: "failed", reason: "queue_full", attempts: 0 });
    } finally {
      releaseFirst();
      server.stop();
    }

    let attempts = 0;
    const retryServer = startServer(() => {
      attempts++;
      return attempts === 1 ? new Response("retry", { status: 503 }) : new Response("ok");
    });
    try {
      const sink = new WebhookSink({
        id: "retry-diagnostic",
        url: retryServer.url,
        maxRetries: 1,
        retryBackoffMs: 0,
      });
      await sink.deliver(event("retry"));
      await sink.flush();
      expect(sink.drainResults()[0]).toMatchObject({ status: "delivered", attempts: 2 });
    } finally {
      retryServer.server.stop();
    }
  });
});
