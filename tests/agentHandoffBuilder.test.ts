import { describe, expect, test } from "bun:test";
import { deriveSocketOutputRequirements } from "../src/handoff/socketOutputRequirements.js";
import {
  AgentHandoffBuilder,
  AgentHandoffBuilderError,
  type AgentHandoffBuilderOptions,
  type AgentHandoffBuilderScope,
} from "../src/runtime/agentHandoffBuilder.js";
import { AgentHandoffBuilderRegistry } from "../src/runtime/agentHandoffBuilderRegistry.js";

const baseScope: AgentHandoffBuilderScope = {
  castId: "cast-1",
  socketId: "Socket-2",
  socketVisit: 1,
  finalizationAttempt: 1,
};

function options(overrides: Partial<AgentHandoffBuilderOptions> = {}): AgentHandoffBuilderOptions {
  return {
    scope: baseScope,
    requirements: deriveSocketOutputRequirements({
      socket: {
        parse: "json",
        assign: { workItems: "$.workItems" },
        edges: [{ when: "satisfied", to: "end" }],
      },
      socketId: baseScope.socketId,
      workItemsProducer: true,
    }),
    workItemsProducer: true,
    ...overrides,
  };
}

function sparseOptions(overrides: Partial<AgentHandoffBuilderOptions> = {}): AgentHandoffBuilderOptions {
  return options({
    requirements: deriveSocketOutputRequirements({
      socket: { parse: "json" },
      socketId: baseScope.socketId,
    }),
    workItemsProducer: false,
    ...overrides,
  });
}

function expectBuilderError(action: () => unknown, code: AgentHandoffBuilderError["code"]): AgentHandoffBuilderError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(AgentHandoffBuilderError);
    expect((error as AgentHandoffBuilderError).code).toBe(code);
    return error as AgentHandoffBuilderError;
  }
  throw new Error(`Expected AgentHandoffBuilderError(${code})`);
}

describe("runtime-owned agent handoff builder", () => {
  test("preserves work-item and event order while deterministically serializing escaping-heavy values", async () => {
    const builder = new AgentHandoffBuilder(options());
    const context = "quoted \"value\"\nC:\\repo\\materia and 東京 🧪";

    builder.setContext(context);
    builder.addEvent({
      type: "status.progress",
      payload: { z: "last", a: "first", nested: { y: 2, x: 1 } },
      message: "Running \"tests\"\nnext line",
    });
    builder.setSatisfied(true);
    builder.addWorkItem({
      title: "feat: preserve \"quoted\" values",
      context: "Keep literal \\n and C:\\repo.\nThen test.",
    });
    builder.addWorkItem({
      title: "test: cover Unicode 東京",
      context: "Preserve combining é and emoji 🚀.",
    });

    const committed = await builder.commit();

    expect(Object.keys(committed.envelope)).toEqual(["workItems", "satisfied", "context"]);
    expect(Object.keys(committed.output)).toEqual(["workItems", "satisfied", "context", "event"]);
    expect(committed.envelope.workItems?.map((item) => item.title)).toEqual([
      "feat: preserve \"quoted\" values",
      "test: cover Unicode 東京",
    ]);
    expect(committed.output.event?.map((event) => event.type)).toEqual(["status.progress"]);
    expect(committed.json).toBe(JSON.stringify({
      workItems: [
        {
          title: "feat: preserve \"quoted\" values",
          context: "Keep literal \\n and C:\\repo.\nThen test.",
        },
        {
          title: "test: cover Unicode 東京",
          context: "Preserve combining é and emoji 🚀.",
        },
      ],
      satisfied: true,
      context,
      event: [{
        type: "status.progress",
        message: "Running \"tests\"\nnext line",
        payload: { a: "first", nested: { x: 1, y: 2 }, z: "last" },
      }],
    }));
    expect(JSON.parse(committed.json)).toEqual(committed.output);
  });

  test("validates value types atomically as fields are submitted", () => {
    const builder = new AgentHandoffBuilder(options());
    builder.addWorkItem({ title: "feat: retained", context: "Keep this item." });

    expectBuilderError(() => builder.setSatisfied("true"), "invalid_value");
    expectBuilderError(() => builder.setContext({ text: "no" }), "invalid_value");
    expectBuilderError(() => builder.addWorkItem({ id: "WI-2", title: "feat: derived id", context: "Agents must not author ids." }), "obsolete_field");
    const issue = expectBuilderError(() => builder.setWorkItems([
      { title: "feat: valid", context: "Would be valid." },
      { title: "fix: missing context" },
    ]), "invalid_value").issues[0];

    expect(issue.path).toBe("$.workItems.1.context");
    expect(builder.snapshot()).toEqual({
      workItems: [{ title: "feat: retained", context: "Keep this item." }],
    });
  });

  test("rejects canonical fields that do not belong to the active socket placement", () => {
    const builder = new AgentHandoffBuilder(sparseOptions());

    builder.setContext("Context is available to every JSON agent socket.");
    expectBuilderError(
      () => builder.addWorkItem({ title: "feat: misplaced", context: "Not a producer." }),
      "misplaced_field",
    );
    expectBuilderError(() => builder.setSatisfied(false), "misplaced_field");
    expect(builder.snapshot()).toEqual({ context: "Context is available to every JSON agent socket." });
  });

  test("rejects obsolete, unknown, renderable-text, and disallowed event fields immediately", () => {
    const builder = new AgentHandoffBuilder(sparseOptions({ allowEventSideChannel: false }));

    for (const field of ["passed", "tasks", "summary", "state"]) {
      const error = expectBuilderError(() => builder.submitField(field, true), "obsolete_field");
      expect(error.issues[0]?.path).toBe(`$.${field}`);
    }
    expectBuilderError(() => builder.submitField("score", 1), "unsupported_field");
    expectBuilderError(() => builder.submitField("text", "render me"), "unsupported_field");
    expectBuilderError(() => builder.addEvent({ type: "status.info" }), "misplaced_field");
    expect(builder.snapshot()).toEqual({});
  });

  test("validates event objects and JSON-compatible event payloads at submission", () => {
    const builder = new AgentHandoffBuilder(sparseOptions());

    expectBuilderError(() => builder.submitField("event", undefined), "invalid_value");
    const invalid = expectBuilderError(
      () => builder.addEvent({ type: "status.progress", severity: "fatal" }),
      "invalid_value",
    );
    expect(invalid.issues[0]?.path).toBe("$.event[0].severity");

    const payload: Record<string, unknown> = {};
    payload.self = payload;
    const circular = expectBuilderError(
      () => builder.addEvent({ type: "status.progress", payload }),
      "invalid_value",
    );
    expect(circular.issues[0]?.path).toBe("$.event[0].payload.self");
    expect(builder.snapshot()).toEqual({});
  });

  test("requires JSON sockets and refuses socket contracts it cannot represent", () => {
    expectBuilderError(() => new AgentHandoffBuilder(options({
      requirements: deriveSocketOutputRequirements({ socket: { parse: "text" } }),
    })), "unsupported_socket");

    expectBuilderError(() => new AgentHandoffBuilder(options({
      requirements: deriveSocketOutputRequirements({
        socket: { parse: "json", assign: { prNotes: "$.text" } },
      }),
    })), "unsupported_socket");

    expectBuilderError(() => new AgentHandoffBuilder(options({
      requirements: deriveSocketOutputRequirements({
        socket: { parse: "json", assign: { score: "$.score" } },
      }),
    })), "unsupported_socket");
  });

  test("retains authoritative commit validation, exactly-once commit, and retry after host failure", async () => {
    const builder = new AgentHandoffBuilder(options());
    await expect(builder.commit()).rejects.toThrow(/Missing required/);

    builder.beginWorkItems();
    builder.setSatisfied(true);
    builder.setContext("ready");
    let attempts = 0;
    await expect(builder.commit(() => {
      attempts += 1;
      throw new Error("normal socket commit unavailable");
    })).rejects.toThrow(/socket commit unavailable/);

    const committed = await builder.commit(() => { attempts += 1; });
    expect(attempts).toBe(2);
    expect(committed.output).toEqual({ workItems: [], satisfied: true, context: "ready" });
    await expect(builder.commit()).rejects.toMatchObject({ code: "closed" });
    expectBuilderError(() => builder.setContext("late"), "closed");
  });

  test("returns defensive snapshots and commit values", async () => {
    const builder = new AgentHandoffBuilder(options());
    builder.beginWorkItems();
    builder.setSatisfied(true);
    builder.setContext("original");
    builder.addEvent({ type: "status.info", payload: { phase: "test" } });

    const snapshot = builder.snapshot();
    snapshot.context = "mutated";
    snapshot.event![0]!.type = "mutated";
    expect(builder.snapshot().context).toBe("original");
    expect(builder.snapshot().event?.[0]?.type).toBe("status.info");

    const committed = await builder.commit((value) => {
      (value.output as { context?: string }).context = "host mutation";
    });
    committed.output.event![0]!.type = "caller mutation";
    expect(builder.committedValue()?.output).toEqual({
      workItems: [],
      satisfied: true,
      context: "original",
      event: [{ type: "status.info", payload: { phase: "test" } }],
    });
  });
});

describe("agent handoff builder registry", () => {
  test("isolates sessions and invalidates partial state across casts, sockets, visits, and attempts", () => {
    const registry = new AgentHandoffBuilderRegistry<object>();
    const sessionA = {};
    const sessionB = {};
    const first = registry.begin(sessionA, sparseOptions());
    first.setContext("must not leak");

    const independent = registry.begin(sessionB, sparseOptions());
    expect(independent.snapshot()).toEqual({});
    expect(registry.get(sessionA, baseScope)).toBe(first);
    expect(registry.get(sessionB, baseScope)).toBe(independent);

    const nextScope = { ...baseScope, socketId: "Socket-3", socketVisit: 2 };
    const next = registry.begin(sessionA, sparseOptions({ scope: nextScope }));
    expect(next.snapshot()).toEqual({});
    expect(registry.get(sessionA, baseScope)).toBeUndefined();
    expect(registry.get(sessionA, nextScope)).toBe(next);
    expectBuilderError(() => first.snapshot(), "closed");

    const retryScope = { ...nextScope, finalizationAttempt: 2 };
    const retry = registry.begin(sessionA, sparseOptions({ scope: retryScope }));
    expect(retry.snapshot()).toEqual({});
    expectBuilderError(() => next.setContext("stale"), "closed");
  });

  test("stale scope cleanup cannot discard a newer attempt", () => {
    const registry = new AgentHandoffBuilderRegistry<object>();
    const session = {};
    const newerScope = { ...baseScope, finalizationAttempt: 2 };
    const original = registry.begin(session, sparseOptions());
    const newer = registry.begin(session, sparseOptions({ scope: newerScope }));

    expect(registry.discard(session, baseScope)).toBe(false);
    expect(registry.get(session, newerScope)).toBe(newer);
    expectBuilderError(() => original.snapshot(), "closed");
    expect(registry.clearSession(session)).toBe(true);
    expect(registry.get(session, newerScope)).toBeUndefined();
    expectBuilderError(() => newer.snapshot(), "closed");
    expect(registry.clearSession(session)).toBe(false);
  });

  test("does not discard an active builder when replacement options are invalid", () => {
    const registry = new AgentHandoffBuilderRegistry<object>();
    const session = {};
    const active = registry.begin(session, sparseOptions());
    active.setContext("still active");

    expectBuilderError(() => registry.begin(session, sparseOptions({
      scope: { ...baseScope, finalizationAttempt: 0 },
    })), "invalid_scope");

    expect(registry.get(session, baseScope)).toBe(active);
    expect(active.snapshot()).toEqual({ context: "still active" });
  });
});
