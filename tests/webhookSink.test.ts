import { randomUUID } from "node:crypto";
import { describe, expect, test } from "bun:test";
import type { Server } from "bun";
import {
  WebhookSink,
  matchesFilter,
} from "../src/runtime/webhookSink.js";
import {
  type EnrichedEvent,
  type EnrichmentContext,
  enrichEvents,
  createSequenceCounter,
} from "../src/domain/eventing.js";
import type { EventingWebhookSinkConfig, EventFilter } from "../src/types.js";

// ── Helpers ─────────────────────────────────────────────────────────────

const baseCtx: EnrichmentContext = {
  castId: "2026-06-16T22-00-00-000Z",
  socketId: "Socket-7",
  materia: "Blackbelt-GH-PR",
  materiaLabel: "GitHub PR Creator",
  visit: 2,
  itemKey: "WI-3",
  itemLabel: "feat: implement retry logic",
};

function freshSeq(): ReturnType<typeof createSequenceCounter> {
  const seq = createSequenceCounter();
  seq.reset();
  return seq;
}

function makeEvent(
  overrides: Partial<EnrichedEvent> & { rawPayload?: Record<string, unknown> } = {},
): EnrichedEvent {
  const seq = freshSeq();
  const base: Record<string, unknown> = { type: "test.event", message: "test message" };
  if (overrides.rawPayload) {
    base.payload = overrides.rawPayload;
  }
  const [event] = enrichEvents([base], baseCtx, seq, () => randomUUID());
  const { rawPayload, ...rest } = overrides;
  return { ...event, ...rest } as EnrichedEvent & { rawPayload?: unknown };
}

function makeResultEvent(): EnrichedEvent {
  return makeEvent({
    type: "result.pr_created",
    message: "PR #42 created",
    payload: { prUrl: "https://github.com/org/repo/pull/42", branchName: "agent/42" },
    severity: "info",
  });
}

function makeLifecycleEvent(): EnrichedEvent {
  return makeEvent({
    type: "lifecycle.cast.started",
    message: "Cast started",
    severity: "info",
  });
}

function webhookConfig(overrides: Partial<EventingWebhookSinkConfig> = {}): EventingWebhookSinkConfig {
  return {
    id: "test-webhook",
    url: "http://localhost:9999/webhook",
    ...overrides,
  };
}

interface RecordedRequest {
  method: string;
  headers: Headers;
  bodyText: string;
  bodyJson?: unknown;
}

/**
 * Start a Bun HTTP server that records every request's method, headers, and body
 * before passing to the handler. The handler receives the request after body
 * capture (headers can still be read; body is consumed but recorded).
 */
function startRecordingServer(
  handler: (recorded: RecordedRequest) => Response | Promise<Response>,
): Promise<{ server: Server; url: string; requests: RecordedRequest[] }> {
  const requests: RecordedRequest[] = [];
  return new Promise((resolve) => {
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const bodyText = await req.text().catch(() => "");
        let bodyJson: unknown = undefined;
        if (bodyText && req.headers.get("Content-Type")?.includes("application/json")) {
          try { bodyJson = JSON.parse(bodyText); } catch { /* not json */ }
        }
        const recorded: RecordedRequest = { method: req.method, headers: req.headers, bodyText, bodyJson };
        requests.push(recorded);
        return handler(recorded);
      },
    });
    const url = `http://localhost:${server.port}/webhook`;
    resolve({ server, url, requests });
  });
}

// ── Event Filter Tests ─────────────────────────────────────────────────

describe("matchesFilter", () => {
  test("returns true when no filter is configured", () => {
    expect(matchesFilter(undefined, "result.pr_created")).toBe(true);
    expect(matchesFilter(undefined, "lifecycle.heartbeat")).toBe(true);
  });

  test("empty include filter passes all events (subject to exclude)", () => {
    const filter: EventFilter = { include: [] };
    expect(matchesFilter(filter, "result.pr_created")).toBe(true);
    expect(matchesFilter(filter, "lifecycle.heartbeat")).toBe(true);
  });

  test("include filter matches exact event types", () => {
    const filter: EventFilter = { include: ["result.pr_created", "lifecycle.heartbeat"] };
    expect(matchesFilter(filter, "result.pr_created")).toBe(true);
    expect(matchesFilter(filter, "lifecycle.heartbeat")).toBe(true);
    expect(matchesFilter(filter, "result.branch_pushed")).toBe(false);
    expect(matchesFilter(filter, "status.progress")).toBe(false);
  });

  test("include filter with wildcards matches glob patterns", () => {
    const filter: EventFilter = { include: ["result.*"] };
    expect(matchesFilter(filter, "result.pr_created")).toBe(true);
    expect(matchesFilter(filter, "result.branch_pushed")).toBe(true);
    expect(matchesFilter(filter, "result.no_changes_needed")).toBe(true);
    expect(matchesFilter(filter, "lifecycle.cast.started")).toBe(false);
    expect(matchesFilter(filter, "status.progress")).toBe(false);
  });

  test("include filter with double-star matches everything", () => {
    const filter: EventFilter = { include: ["**"] };
    expect(matchesFilter(filter, "result.pr_created")).toBe(true);
    expect(matchesFilter(filter, "lifecycle.heartbeat")).toBe(true);
    expect(matchesFilter(filter, "anything.at.all.deep.nested")).toBe(true);
  });

  test("include filter with single star matches any single segment", () => {
    const filter: EventFilter = { include: ["*.progress"] };
    expect(matchesFilter(filter, "status.progress")).toBe(true);
    expect(matchesFilter(filter, "build.progress")).toBe(true);
    expect(matchesFilter(filter, "result.progress")).toBe(true);
    expect(matchesFilter(filter, "result.pr_created")).toBe(false);
    expect(matchesFilter(filter, "a.b.progress")).toBe(false);
  });

  test("exclude filter blocks events even if they match include", () => {
    const filter: EventFilter = {
      include: ["result.*"],
      exclude: ["result.debug_*"],
    };
    expect(matchesFilter(filter, "result.pr_created")).toBe(true);
    expect(matchesFilter(filter, "result.debug_trace")).toBe(false);
    expect(matchesFilter(filter, "result.debug_info")).toBe(false);
  });

  test("exclude filter without include blocks specific events from all", () => {
    const filter: EventFilter = { exclude: ["lifecycle.heartbeat", "lifecycle.debug_*"] };
    expect(matchesFilter(filter, "lifecycle.heartbeat")).toBe(false);
    expect(matchesFilter(filter, "lifecycle.debug_trace")).toBe(false);
    expect(matchesFilter(filter, "lifecycle.cast.started")).toBe(true);
    expect(matchesFilter(filter, "result.pr_created")).toBe(true);
  });

  test("exclude wins over include for overlapping patterns", () => {
    const filter: EventFilter = {
      include: ["**"],
      exclude: ["lifecycle.heartbeat"],
    };
    expect(matchesFilter(filter, "result.pr_created")).toBe(true);
    expect(matchesFilter(filter, "lifecycle.heartbeat")).toBe(false);
    expect(matchesFilter(filter, "lifecycle.cast.started")).toBe(true);
  });

  test("nested wildcards with double star + segment", () => {
    const filter: EventFilter = { include: ["lifecycle.**.failed"] };
    expect(matchesFilter(filter, "lifecycle.cast.failed")).toBe(true);
    expect(matchesFilter(filter, "lifecycle.socket.failed")).toBe(true);
    // ** matches zero or more segments, so "lifecycle.failed" matches
    // (the ** consumes zero segments between "lifecycle" and "failed").
    expect(matchesFilter(filter, "lifecycle.failed")).toBe(true);
    expect(matchesFilter(filter, "lifecycle.a.b.failed")).toBe(true);
  });

  test("literal patterns without wildcards match exactly", () => {
    const filter: EventFilter = { include: ["result.pr_created"] };
    expect(matchesFilter(filter, "result.pr_created")).toBe(true);
    expect(matchesFilter(filter, "result.pr_created_extra")).toBe(false);
    expect(matchesFilter(filter, "result.pr_creat")).toBe(false);
  });
});

// ── WebhookSink ─────────────────────────────────────────────────────────

describe("WebhookSink", () => {
  // ── Construction & State ────────────────────────────────────────────
  describe("construction", () => {
    test("has correct id from config", () => {
      const sink = new WebhookSink(webhookConfig({ id: "my-webhook" }));
      expect(sink.id).toBe("my-webhook");
    });

    test("is enabled by default", () => {
      const sink = new WebhookSink(webhookConfig());
      expect(sink.enabled).toBe(true);
    });

    test("can be explicitly disabled", () => {
      const sink = new WebhookSink(webhookConfig({ enabled: false }));
      expect(sink.enabled).toBe(false);
    });

    test("consecutive failures start at 0", () => {
      const sink = new WebhookSink(webhookConfig());
      expect(sink.consecutiveFailures).toBe(0);
    });
  });

  // ── Delivery ───────────────────────────────────────────────────────
  describe("deliver", () => {
    test("sends a POST request to the configured URL", async () => {
      const { server, url, requests } = await startRecordingServer(
        () => new Response("ok", { status: 200 }),
      );
      try {
        const sink = new WebhookSink(webhookConfig({ url }));
        await sink.deliver(makeResultEvent());
        await sink.flush();

        expect(requests).toHaveLength(1);
        expect(requests[0].method).toBe("POST");
      } finally {
        server.stop();
      }
    });

    test("sends configured method (PUT)", async () => {
      const { server, url, requests } = await startRecordingServer(
        () => new Response("ok", { status: 200 }),
      );
      try {
        const sink = new WebhookSink(webhookConfig({ url, method: "PUT" }));
        await sink.deliver(makeResultEvent());
        await sink.flush();

        expect(requests[0].method).toBe("PUT");
      } finally {
        server.stop();
      }
    });

    test("includes Content-Type header by default", async () => {
      const { server, url, requests } = await startRecordingServer(
        () => new Response("ok", { status: 200 }),
      );
      try {
        const sink = new WebhookSink(webhookConfig({ url }));
        await sink.deliver(makeResultEvent());
        await sink.flush();

        expect(requests[0].headers.get("Content-Type")).toBe("application/json");
      } finally {
        server.stop();
      }
    });

    test("includes custom headers", async () => {
      const { server, url, requests } = await startRecordingServer(
        () => new Response("ok", { status: 200 }),
      );
      try {
        const sink = new WebhookSink(
          webhookConfig({
            url,
            headers: {
              Authorization: "Bearer secret-token-abc123",
              "X-Custom": "custom-value",
            },
          }),
        );
        await sink.deliver(makeResultEvent());
        await sink.flush();

        expect(requests[0].headers.get("Authorization")).toBe("Bearer secret-token-abc123");
        expect(requests[0].headers.get("X-Custom")).toBe("custom-value");
      } finally {
        server.stop();
      }
    });

    test("passthrough body template sends full enriched event", async () => {
      const { server, url, requests } = await startRecordingServer(
        () => new Response("ok", { status: 200 }),
      );
      try {
        const sink = new WebhookSink(
          webhookConfig({ url, bodyTemplate: "passthrough" }),
        );
        const event = makeResultEvent();
        await sink.deliver(event);
        await sink.flush();

        expect(requests[0].bodyJson).toBeTruthy();
        const body = requests[0].bodyJson as Record<string, unknown>;
        expect(body.eventId).toBe(event.eventId);
        expect(body.type).toBe("result.pr_created");
        expect(body.castId).toBe(event.castId);
        expect(body.payload).toEqual(event.payload);
      } finally {
        server.stop();
      }
    });

    test("none body template sends empty object", async () => {
      const { server, url, requests } = await startRecordingServer(
        () => new Response("ok", { status: 200 }),
      );
      try {
        const sink = new WebhookSink(
          webhookConfig({ url, bodyTemplate: "none" }),
        );
        await sink.deliver(makeResultEvent());
        await sink.flush();

        expect(requests[0].bodyJson).toEqual({});
      } finally {
        server.stop();
      }
    });

    test("mapped body template uses default field names", async () => {
      const { server, url, requests } = await startRecordingServer(
        () => new Response("ok", { status: 200 }),
      );
      try {
        const sink = new WebhookSink(
          webhookConfig({
            url,
            bodyTemplate: "mapped",
            bodyMapping: {},
          }),
        );
        await sink.deliver(makeResultEvent());
        await sink.flush();

        const body = requests[0].bodyJson as Record<string, unknown>;
        expect(body.eventId).toBeString();
        expect(body.eventType).toBe("result.pr_created");
        expect(body.severity).toBe("info");
        expect(body.message).toBe("PR #42 created");
      } finally {
        server.stop();
      }
    });

    test("mapped body template remaps field names", async () => {
      const { server, url, requests } = await startRecordingServer(
        () => new Response("ok", { status: 200 }),
      );
      try {
        const event = makeResultEvent();
        const sink = new WebhookSink(
          webhookConfig({
            url,
            bodyTemplate: "mapped",
            bodyMapping: {
              eventId: "eventId",
              eventType: "type",
              severity: "severity",
              message: "message",
              // Use static fields for keys not in EventBodyFieldMapping:
              static: { runtimeRunId: event.castId },
            },
          }),
        );
        await sink.deliver(event);
        await sink.flush();

        const body = requests[0].bodyJson as Record<string, unknown>;
        expect(body.eventId).toBe(event.eventId);
        expect(body.eventType).toBe("result.pr_created");
        expect(body.runtimeRunId).toBe(event.castId);
        expect(body.severity).toBe("info");
        expect(body.message).toBe("PR #42 created");
        // No unexpected fields leaked from the template
        expect(body.type).toBeUndefined();
        expect(body.castId).toBeUndefined();
      } finally {
        server.stop();
      }
    });

    test("mapped body includes static fields", async () => {
      const { server, url, requests } = await startRecordingServer(
        () => new Response("ok", { status: 200 }),
      );
      try {
        const sink = new WebhookSink(
          webhookConfig({
            url,
            bodyTemplate: "mapped",
            bodyMapping: {
              eventId: "eventId",
              static: {
                source: "pi-materia",
                version: "1.0.0",
                environment: "production",
              },
            },
          }),
        );
        await sink.deliver(makeResultEvent());
        await sink.flush();

        const body = requests[0].bodyJson as Record<string, unknown>;
        expect(body.source).toBe("pi-materia");
        expect(body.version).toBe("1.0.0");
        expect(body.environment).toBe("production");
      } finally {
        server.stop();
      }
    });

    test("static fields override mapped fields", async () => {
      const { server, url, requests } = await startRecordingServer(
        () => new Response("ok", { status: 200 }),
      );
      try {
        const sink = new WebhookSink(
          webhookConfig({
            url,
            bodyTemplate: "mapped",
            bodyMapping: {
              eventId: "eventId",
              static: { eventId: "overridden" },
            },
          }),
        );
        await sink.deliver(makeResultEvent());
        await sink.flush();

        const body = requests[0].bodyJson as Record<string, unknown>;
        expect(body.eventId).toBe("overridden");
      } finally {
        server.stop();
      }
    });

    test("mapped body payload field is included", async () => {
      const { server, url, requests } = await startRecordingServer(
        () => new Response("ok", { status: 200 }),
      );
      try {
        const sink = new WebhookSink(
          webhookConfig({
            url,
            bodyTemplate: "mapped",
            bodyMapping: { payload: "payload" },
          }),
        );
        const event = makeResultEvent();
        await sink.deliver(event);
        await sink.flush();

        const body = requests[0].bodyJson as Record<string, unknown>;
        expect(body.payload).toEqual(event.payload);
      } finally {
        server.stop();
      }
    });

    test("deliver returns immediately without blocking", async () => {
      // Create a server that delays responses to prove deliver is non-blocking.
      const { server, url, requests } = await startRecordingServer(
        () => new Promise((resolve) => setTimeout(() => resolve(new Response("ok", { status: 200 })), 200)),
      );
      try {
        const sink = new WebhookSink(webhookConfig({ url, timeoutMs: 500 }));
        const start = Date.now();
        await sink.deliver(makeResultEvent());
        const elapsed = Date.now() - start;

        // deliver should return in <50ms even though the server takes 200ms.
        expect(elapsed).toBeLessThan(100);

        // After flush, the request should have completed.
        await sink.flush();
        expect(requests).toHaveLength(1);
      } finally {
        server.stop();
      }
    });
  });

  // ── Event Filtering ────────────────────────────────────────────────
  describe("event filtering", () => {
    test("delivers all events when no filter is configured", async () => {
      const { server, url, requests } = await startRecordingServer(
        () => new Response("ok", { status: 200 }),
      );
      try {
        const sink = new WebhookSink(webhookConfig({ url }));
        await sink.deliver(makeResultEvent());
        await sink.deliver(makeLifecycleEvent());
        await sink.deliver(makeEvent({ type: "status.progress" }));
        await sink.flush();

        expect(requests).toHaveLength(3);
      } finally {
        server.stop();
      }
    });

    test("include filter only delivers matching events", async () => {
      const { server, url, requests } = await startRecordingServer(
        () => new Response("ok", { status: 200 }),
      );
      try {
        const sink = new WebhookSink(
          webhookConfig({
            url,
            eventFilter: { include: ["result.*"] },
          }),
        );
        await sink.deliver(makeResultEvent());
        await sink.deliver(makeLifecycleEvent());
        await sink.deliver(makeEvent({ type: "result.branch_pushed" }));
        await sink.flush();

        // Only result.* events should be delivered
        expect(requests).toHaveLength(2);
      } finally {
        server.stop();
      }
    });

    test("exclude filter blocks matching events", async () => {
      const { server, url, requests } = await startRecordingServer(
        () => new Response("ok", { status: 200 }),
      );
      try {
        const sink = new WebhookSink(
          webhookConfig({
            url,
            eventFilter: { exclude: ["lifecycle.heartbeat"] },
          }),
        );
        await sink.deliver(makeResultEvent());
        await sink.deliver(makeEvent({ type: "lifecycle.heartbeat" }));
        await sink.flush();

        expect(requests).toHaveLength(1);
        const body = requests[0].bodyJson as Record<string, unknown>;
        expect(body.eventType).toBe("result.pr_created");
      } finally {
        server.stop();
      }
    });

    test("filtered events do not count as failures", async () => {
      const sink = new WebhookSink(
        webhookConfig({
          url: "http://localhost:9999/never-called",
          eventFilter: { include: ["result.*"] },
        }),
      );
      // This should be filtered out — no HTTP request made
      await sink.deliver(makeLifecycleEvent());
      await sink.flush();
      expect(sink.consecutiveFailures).toBe(0);
    });
  });

  // ── Disabled Sink ──────────────────────────────────────────────────
  describe("disabled sink", () => {
    test("does not make HTTP requests when disabled", async () => {
      const { server, url, requests } = await startRecordingServer(
        () => new Response("ok", { status: 200 }),
      );
      try {
        const sink = new WebhookSink(webhookConfig({ url, enabled: false }));
        await sink.deliver(makeResultEvent());
        await sink.flush();
        expect(requests).toHaveLength(0);
      } finally {
        server.stop();
      }
    });

    test("does not throw when disabled", async () => {
      const sink = new WebhookSink(webhookConfig({ enabled: false }));
      // Should not throw
      await sink.deliver(makeResultEvent());
      await sink.flush();
    });
  });

  // ── Retries ────────────────────────────────────────────────────────
  describe("retries", () => {
    test("retries on 5xx errors up to maxRetries", async () => {
      let attempts = 0;
      const { server, url } = await startRecordingServer(
        () => {
          attempts++;
          return new Response("server error", { status: 503 });
        },
      );
      try {
        const sink = new WebhookSink(webhookConfig({ url, maxRetries: 2 }));
        // deliver is non-blocking — it enqueues and returns immediately.
        await sink.deliver(makeResultEvent());
        await sink.flush();
        // Initial attempt + 2 retries = 3 total
        expect(attempts).toBe(3);
        expect(sink.consecutiveFailures).toBe(1);
      } finally {
        server.stop();
      }
    });

    test("succeeds on retry after transient 5xx", async () => {
      let attempts = 0;
      const { server, url } = await startRecordingServer(
        () => {
          attempts++;
          if (attempts <= 2) return new Response("server error", { status: 500 });
          return new Response("ok", { status: 200 });
        },
      );
      try {
        const sink = new WebhookSink(
          webhookConfig({ url, maxRetries: 3, retryBackoffMs: 1, maxBackoffMs: 10 }),
        );
        await sink.deliver(makeResultEvent());
        await sink.flush();
        // Succeeds on 3rd try
        expect(attempts).toBe(3);
        expect(sink.consecutiveFailures).toBe(0);
      } finally {
        server.stop();
      }
    });

    test("does not retry on 4xx errors", async () => {
      let attempts = 0;
      const { server, url } = await startRecordingServer(
        () => {
          attempts++;
          return new Response("bad request", { status: 400 });
        },
      );
      try {
        const sink = new WebhookSink(webhookConfig({ url, maxRetries: 3 }));
        await sink.deliver(makeResultEvent());
        await sink.flush();
        expect(attempts).toBe(1);
        expect(sink.consecutiveFailures).toBe(1);
      } finally {
        server.stop();
      }
    });

    test("does not retry on 404", async () => {
      let attempts = 0;
      const { server, url } = await startRecordingServer(
        () => {
          attempts++;
          return new Response("not found", { status: 404 });
        },
      );
      try {
        const sink = new WebhookSink(webhookConfig({ url }));
        await sink.deliver(makeResultEvent());
        await sink.flush();
        expect(attempts).toBe(1);
        expect(sink.consecutiveFailures).toBe(1);
      } finally {
        server.stop();
      }
    });

    test("retry backoff increases with each attempt", async () => {
      const timestamps: number[] = [];
      const { server, url } = await startRecordingServer(
        () => {
          timestamps.push(Date.now());
          return new Response("server error", { status: 503 });
        },
      );
      try {
        const sink = new WebhookSink(
          webhookConfig({ url, maxRetries: 2, retryBackoffMs: 50, maxBackoffMs: 1000 }),
        );
        await sink.deliver(makeResultEvent());
        await sink.flush();

        // Check that backoff times increase
        const delays = [];
        for (let i = 1; i < timestamps.length; i++) {
          delays.push(timestamps[i] - timestamps[i - 1]);
        }
        // First retry should have at least baseMs (50ms) delay
        // Allow some timing variance (±10ms)
        expect(delays[0]).toBeGreaterThanOrEqual(40);
        // Second retry should be at least as long as the first
        if (delays.length > 1) {
          expect(delays[1]).toBeGreaterThanOrEqual(delays[0] - 5);
        }
      } finally {
        server.stop();
      }
    });
  });

  // ── Timeout ────────────────────────────────────────────────────────
  describe("timeout", () => {
    test("times out after configured timeoutMs", async () => {
      const { server, url } = await startRecordingServer(
        () => new Promise((resolve) => setTimeout(() => resolve(new Response("ok")), 500)),
      );
      try {
        const sink = new WebhookSink(
          webhookConfig({ url, timeoutMs: 50, maxRetries: 0 }),
        );
        await sink.deliver(makeResultEvent());
        await sink.flush();
        // Failure recorded as a consecutive failure, not thrown.
        expect(sink.consecutiveFailures).toBe(1);
      } finally {
        server.stop();
      }
    });

    test("timeout errors are retryable and can eventually succeed", async () => {
      // Use a server that is slow on the first attempt but fast on retry.
      let attempt = 0;
      const { server, url } = await startRecordingServer(
        (recorded) => {
          attempt++;
          if (attempt <= 1) {
            // First attempt: respond slowly, triggering client timeout
            return new Promise((resolve) =>
              setTimeout(() => resolve(new Response("ok")), 200),
            );
          }
          // Subsequent attempts: respond immediately
          return new Response("ok", { status: 200 });
        },
      );
      try {
        const sink = new WebhookSink(
          webhookConfig({ url, timeoutMs: 50, maxRetries: 2, retryBackoffMs: 1, maxBackoffMs: 10 }),
        );
        await sink.deliver(makeResultEvent());
        await sink.flush();
        // Should succeed on retry (attempt 2)
        expect(attempt).toBe(2);
      } finally {
        server.stop();
      }
    });
  });

  // ── Consecutive Failure Discarding ─────────────────────────────────
  describe("discarding", () => {
    test("disables itself after discardingAfter consecutive failures", async () => {
      const { server, url } = await startRecordingServer(
        () => new Response("server error", { status: 500 }),
      );
      try {
        const sink = new WebhookSink(
          webhookConfig({ url, maxRetries: 0, discardingAfter: 3 }),
        );

        // Fail 3 times in a row (deliver never throws — failures are async)
        await sink.deliver(makeResultEvent());
        await sink.flush();
        expect(sink.enabled).toBe(true);
        await sink.deliver(makeResultEvent());
        await sink.flush();
        expect(sink.enabled).toBe(true);
        await sink.deliver(makeResultEvent());
        await sink.flush();
        // Now it should be disabled
        expect(sink.enabled).toBe(false);

        // Further deliveries should be no-ops
        await sink.deliver(makeResultEvent()); // no throw
        await sink.flush();
      } finally {
        server.stop();
      }
    });

    test("resets consecutive failures after successful delivery", async () => {
      let callCount = 0;
      const { server, url } = await startRecordingServer(
        () => {
          callCount++;
          if (callCount <= 2) return new Response("server error", { status: 500 });
          return new Response("ok", { status: 200 });
        },
      );
      try {
        const sink = new WebhookSink(
          webhookConfig({ url, maxRetries: 0, discardingAfter: 3 }),
        );

        // Fail twice
        await sink.deliver(makeResultEvent());
        await sink.flush();
        await sink.deliver(makeResultEvent());
        await sink.flush();
        expect(sink.consecutiveFailures).toBe(2);

        // Succeed once
        await sink.deliver(makeResultEvent());
        await sink.flush();
        expect(sink.consecutiveFailures).toBe(0);
        expect(sink.enabled).toBe(true);
      } finally {
        server.stop();
      }
    });
  });

  // ── Error Message Redaction ────────────────────────────────────────
  describe("error message redaction", () => {
    test("error messages do not contain header secret values", async () => {
      const { server, url } = await startRecordingServer(
        () => new Response("unauthorized", { status: 401 }),
      );
      try {
        const sink = new WebhookSink(
          webhookConfig({
            url,
            headers: { Authorization: "Bearer supersecrettoken12345" },
          }),
        );
        await sink.deliver(makeResultEvent());
        await sink.flush();

        // Failure is recorded in async outcomes, not thrown.
        const outcomes = sink.drainOutcomes();
        expect(outcomes).toHaveLength(1);
        const failureMsg = outcomes[0].failures[0]?.error ?? "";
        expect(failureMsg).not.toContain("supersecrettoken12345");
        expect(failureMsg).not.toContain("Bearer");
        expect(failureMsg).toContain("HTTP 401");
      } finally {
        server.stop();
      }
    });

    test("error messages redact URL query parameters", async () => {
      // Use a URL with a token in query params. The host is non-existent
      // so fetch will fail with a connect error, but the URL redaction
      // should still strip the query string from the error message.
      const sink = new WebhookSink(
        webhookConfig({
          url: "http://localhost:9/webhook?token=secret123&user=admin",
          timeoutMs: 100,
          maxRetries: 0,
        }),
      );
      await sink.deliver(makeResultEvent());
      await sink.flush();

      const outcomes = sink.drainOutcomes();
      expect(outcomes).toHaveLength(1);
      const failureMsg = outcomes[0].failures[0]?.error ?? "";
      // Should not contain the token
      expect(failureMsg).not.toContain("secret123");
    });

    test("delivery errors don't leak connection details", async () => {
      // Use a non-routable address to trigger a network error
      const sink = new WebhookSink(
        webhookConfig({ url: "http://192.0.2.1:1/webhook", maxRetries: 0, timeoutMs: 200 }),
      );
      await sink.deliver(makeResultEvent());
      await sink.flush();

      const outcomes = sink.drainOutcomes();
      expect(outcomes).toHaveLength(1);
      const failureMsg = outcomes[0].failures[0]?.error ?? "";
      // Should not contain raw stack trace
      expect(failureMsg).not.toContain("at ");
      expect(failureMsg).not.toContain("webhookSink.ts");
    });

    test("won't error with extra unknown event fields", async () => {
      const { server, url, requests } = await startRecordingServer(
        () => new Response("ok", { status: 200 }),
      );
      try {
        const sink = new WebhookSink(
          webhookConfig({ url, bodyTemplate: "passthrough" }),
        );
        // Create an event with an unknown forward-compatible field
        const event = makeResultEvent();
        const extraEvent = { ...event, customField: "value", anotherField: 42 };

        await sink.deliver(extraEvent);
        await sink.flush();

        const body = requests[0].bodyJson as Record<string, unknown>;
        expect(body.customField).toBe("value");
        expect(body.anotherField).toBe(42);
      } finally {
        server.stop();
      }
    });
  });

  // ── Edge Cases ─────────────────────────────────────────────────────
  describe("edge cases", () => {
    test("empty body mapping still sends Content-Type: application/json", async () => {
      const { server, url, requests } = await startRecordingServer(
        () => new Response("ok", { status: 200 }),
      );
      try {
        const sink = new WebhookSink(
          webhookConfig({ url, bodyTemplate: "mapped", bodyMapping: undefined }),
        );
        await sink.deliver(makeResultEvent());
        await sink.flush();

        expect(requests[0].headers.get("Content-Type")).toBe("application/json");
      } finally {
        server.stop();
      }
    });

    test("uses default mapped body template when bodyTemplate is not specified", async () => {
      const { server, url, requests } = await startRecordingServer(
        () => new Response("ok", { status: 200 }),
      );
      try {
        // No bodyTemplate specified — should default to "mapped"
        const sink = new WebhookSink(webhookConfig({ url }));
        await sink.deliver(makeResultEvent());
        await sink.flush();

        const body = requests[0].bodyJson as Record<string, unknown>;
        expect(body.eventId).toBeString();
        expect(body.eventType).toBe("result.pr_created");
      } finally {
        server.stop();
      }
    });

    test("multiple events delivered in order", async () => {
      const types: string[] = [];
      const { server, url } = await startRecordingServer(
        (recorded) => {
          if (recorded.bodyJson && typeof recorded.bodyJson === "object") {
            const b = recorded.bodyJson as Record<string, unknown>;
            if (typeof b.eventType === "string") types.push(b.eventType);
          }
          return new Response("ok", { status: 200 });
        },
      );
      try {
        const sink = new WebhookSink(webhookConfig({ url }));

        const e1 = makeEvent({ type: "first" });
        const e2 = makeEvent({ type: "second" });
        const e3 = makeEvent({ type: "third" });

        await sink.deliver(e1);
        await sink.deliver(e2);
        await sink.deliver(e3);
        await sink.flush();

        expect(types).toEqual(["first", "second", "third"]);
      } finally {
        server.stop();
      }
    });

    test("sink with explicit kind webhook works", async () => {
      const { server, url } = await startRecordingServer(
        () => new Response("ok", { status: 200 }),
      );
      try {
        const sink = new WebhookSink(webhookConfig({ url, kind: "webhook" }));
        await sink.deliver(makeResultEvent());
        await sink.flush();
        // Should not throw — sink with kind: "webhook" is valid
      } finally {
        server.stop();
      }
    });

    test("drainOutcomes returns async dispatch outcomes", async () => {
      const { server, url } = await startRecordingServer(
        () => new Response("ok", { status: 200 }),
      );
      try {
        const sink = new WebhookSink(webhookConfig({ url }));
        await sink.deliver(makeResultEvent());
        await sink.flush();

        const outcomes = sink.drainOutcomes();
        expect(outcomes).toHaveLength(1);
        expect(outcomes[0].eventId).toBeString();
        expect(outcomes[0].deliveredTo).toEqual(["test-webhook"]);
        expect(outcomes[0].failures).toEqual([]);

        // Second call should return empty — outcomes are drained.
        expect(sink.drainOutcomes()).toEqual([]);
      } finally {
        server.stop();
      }
    });

    test("drainOutcomes captures failures from async delivery", async () => {
      const { server, url } = await startRecordingServer(
        () => new Response("server error", { status: 500 }),
      );
      try {
        const sink = new WebhookSink(
          webhookConfig({ url, maxRetries: 0 }),
        );
        await sink.deliver(makeResultEvent());
        await sink.flush();

        const outcomes = sink.drainOutcomes();
        expect(outcomes).toHaveLength(1);
        expect(outcomes[0].deliveredTo).toEqual([]);
        expect(outcomes[0].failures).toHaveLength(1);
        expect(outcomes[0].failures[0].sinkId).toBe("test-webhook");
        expect(outcomes[0].failures[0].error).toContain("HTTP 500");
      } finally {
        server.stop();
      }
    });

    test("flush is idempotent when no deliveries are pending", async () => {
      const sink = new WebhookSink(webhookConfig({ url: "http://localhost:9/webhook" }));
      // Should not throw
      await sink.flush();
      await sink.flush();
    });

    test("successful delivery resets outcome tracking", async () => {
      const { server, url } = await startRecordingServer(
        () => new Response("ok", { status: 200 }),
      );
      try {
        const sink = new WebhookSink(webhookConfig({ url }));

        // Deliver two events
        await sink.deliver(makeEvent({ type: "first" }));
        await sink.deliver(makeEvent({ type: "second" }));
        await sink.flush();

        const outcomes = sink.drainOutcomes();
        expect(outcomes).toHaveLength(2);
        expect(outcomes[0].deliveredTo).toEqual(["test-webhook"]);
        expect(outcomes[1].deliveredTo).toEqual(["test-webhook"]);
      } finally {
        server.stop();
      }
    });
  });
});

// ── drainResults: rich per-event async dispatch outcomes ───────────────

describe("WebhookSink drainResults (real async dispatch outcomes)", () => {
  test("delivered result carries status and HTTP status code", async () => {
    const { server, url } = await startRecordingServer(
      () => new Response("ok", { status: 200 }),
    );
    try {
      const sink = new WebhookSink(webhookConfig({ url }));
      const event = makeResultEvent();
      await sink.deliver(event);
      await sink.flush();

      const results = sink.drainResults();
      expect(results).toHaveLength(1);
      expect(results[0].eventId).toBe(event.eventId);
      expect(results[0].sinkId).toBe("test-webhook");
      expect(results[0].status).toBe("delivered");
      expect(results[0].statusCode).toBe(200);
      expect(results[0].reason).toBeUndefined();
      expect(results[0].error).toBeUndefined();

      // Draining clears the buffer.
      expect(sink.drainResults()).toEqual([]);
    } finally {
      server.stop();
    }
  });

  test("5xx failure records failed status, status code, and http_error reason", async () => {
    const { server, url } = await startRecordingServer(
      () => new Response("server error", { status: 500 }),
    );
    try {
      const sink = new WebhookSink(webhookConfig({ url, maxRetries: 0 }));
      await sink.deliver(makeResultEvent());
      await sink.flush();

      const [result] = sink.drainResults();
      expect(result.status).toBe("failed");
      expect(result.statusCode).toBe(500);
      expect(result.reason).toBe("http_error");
      expect(result.error).toContain("HTTP 500");
    } finally {
      server.stop();
    }
  });

  test("4xx non-retryable failure is recorded without retrying", async () => {
    let hits = 0;
    const { server, url } = await startRecordingServer(
      () => { hits++; return new Response("bad request", { status: 400 }); },
    );
    try {
      const sink = new WebhookSink(webhookConfig({ url, maxRetries: 3 }));
      await sink.deliver(makeResultEvent());
      await sink.flush();

      const [result] = sink.drainResults();
      expect(result.status).toBe("failed");
      expect(result.statusCode).toBe(400);
      expect(result.reason).toBe("http_error");
      // 4xx must not be retried even with a high maxRetries.
      expect(hits).toBe(1);
    } finally {
      server.stop();
    }
  });

  test("network error records failed status with network_error reason and no status code", async () => {
    // Closed localhost port → immediate connection refused (not a timeout race).
    const sink = new WebhookSink(
      webhookConfig({ url: "http://localhost:9/webhook", maxRetries: 0, timeoutMs: 5000 }),
    );
    await sink.deliver(makeResultEvent());
    await sink.flush();

    const [result] = sink.drainResults();
    expect(result.status).toBe("failed");
    expect(result.reason).toBe("network_error");
    expect(result.statusCode).toBeUndefined();
    expect(result.error).not.toContain("at ");
    expect(result.error).not.toContain("webhookSink.ts");
  });

  test("timeout records failed status with timeout reason", async () => {
    const { server, url } = await startRecordingServer(
      () => new Promise((resolve) => setTimeout(() => resolve(new Response("ok", { status: 200 })), 1000)),
    );
    try {
      const sink = new WebhookSink(webhookConfig({ url, timeoutMs: 50, maxRetries: 0 }));
      await sink.deliver(makeResultEvent());
      await sink.flush();

      const [result] = sink.drainResults();
      expect(result.status).toBe("failed");
      expect(result.reason).toBe("timeout");
      expect(result.error).toContain("timed out");
    } finally {
      server.stop();
    }
  });

  test("filtered-out event records skipped status with filtered_out reason (no network call)", async () => {
    let hits = 0;
    const { server, url } = await startRecordingServer(
      () => { hits++; return new Response("ok", { status: 200 }); },
    );
    try {
      const sink = new WebhookSink(
        webhookConfig({ url, eventFilter: { include: ["result.*"] } }),
      );
      const event = makeEvent({ type: "lifecycle.heartbeat" });
      await sink.deliver(event);
      await sink.flush();

      const [result] = sink.drainResults();
      expect(result.eventId).toBe(event.eventId);
      expect(result.status).toBe("skipped");
      expect(result.reason).toBe("filtered_out");
      // The filtered event never reached the server.
      expect(hits).toBe(0);
    } finally {
      server.stop();
    }
  });

  test("missing URL records misconfigured status with target_url_missing reason", async () => {
    const sink = new WebhookSink(webhookConfig({ url: "" }));
    const event = makeResultEvent();
    await sink.deliver(event);
    await sink.flush();

    const [result] = sink.drainResults();
    expect(result.eventId).toBe(event.eventId);
    expect(result.status).toBe("misconfigured");
    expect(result.reason).toBe("target_url_missing");
    expect(result.error).toContain("missing");
  });

  test("non-http URL records misconfigured status with target_url_invalid reason", async () => {
    const sink = new WebhookSink(webhookConfig({ url: "ftp://example.com/hook" }));
    await sink.deliver(makeResultEvent());
    await sink.flush();

    const [result] = sink.drainResults();
    expect(result.status).toBe("misconfigured");
    expect(result.reason).toBe("target_url_invalid");
    expect(result.error).toContain("http(s)");
  });

  test("malformed URL records misconfigured status with target_url_invalid reason", async () => {
    const sink = new WebhookSink(webhookConfig({ url: "not-a-url" }));
    await sink.deliver(makeResultEvent());
    await sink.flush();

    const [result] = sink.drainResults();
    expect(result.status).toBe("misconfigured");
    expect(result.reason).toBe("target_url_invalid");
  });

  test("drainOutcomes legacy adapter derives deliveredTo/failures from rich results", async () => {
    const { server, url } = await startRecordingServer(
      () => new Response("ok", { status: 201 }),
    );
    try {
      const sink = new WebhookSink(webhookConfig({ url }));
      await sink.deliver(makeResultEvent());
      await sink.flush();

      const outcomes = sink.drainOutcomes();
      expect(outcomes).toHaveLength(1);
      expect(outcomes[0].deliveredTo).toEqual(["test-webhook"]);
      expect(outcomes[0].failures).toEqual([]);
    } finally {
      server.stop();
    }
  });
});

// ── globMatch through matchesFilter — additional corner cases ───────────

describe("globMatch corner cases", () => {
  test("pattern with multiple ** segments", () => {
    const filter: EventFilter = { include: ["lifecycle.**.failed"] };
    expect(matchesFilter(filter, "lifecycle.deeply.nested.failed")).toBe(true);
    // ** matches zero or more segments, so "lifecycle.failed" matches
    expect(matchesFilter(filter, "lifecycle.failed")).toBe(true);
    expect(matchesFilter(filter, "other.lifecycle.failed")).toBe(false);
  });

  test("** at start", () => {
    const filter: EventFilter = { include: ["**.failed"] };
    expect(matchesFilter(filter, "lifecycle.cast.failed")).toBe(true);
    expect(matchesFilter(filter, "result.failed")).toBe(true);
    // ** matches zero or more segments, so "failed" matches
    expect(matchesFilter(filter, "failed")).toBe(true);
  });

  test("** only (matches everything)", () => {
    const filter: EventFilter = { include: ["**"] };
    // "**" alone returns true immediately via fast-path (matches everything
    // including empty string).
    expect(matchesFilter(filter, "")).toBe(true);
    expect(matchesFilter(filter, "a")).toBe(true);
    expect(matchesFilter(filter, "a.b.c.d")).toBe(true);
  });

  test("exact match with dots", () => {
    const filter: EventFilter = { include: ["lifecycle.cast.started"] };
    expect(matchesFilter(filter, "lifecycle.cast.started")).toBe(true);
    expect(matchesFilter(filter, "lifecycle.cast.started.")).toBe(false);
    expect(matchesFilter(filter, ".lifecycle.cast.started")).toBe(false);
  });

  test("within-segment wildcard *", () => {
    const filter: EventFilter = { include: ["result.debug_*"] };
    expect(matchesFilter(filter, "result.debug_trace")).toBe(true);
    expect(matchesFilter(filter, "result.debug_info")).toBe(true);
    // "debug" does NOT match "debug_*" because the literal "_" is required
    expect(matchesFilter(filter, "result.debug")).toBe(false);
    expect(matchesFilter(filter, "result.production")).toBe(false);
  });
});
