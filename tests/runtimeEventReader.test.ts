import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import type { EnrichedEvent } from "../src/domain/eventing.js";
import {
  DEFAULT_RUNTIME_EVENT_LIMIT,
  RUNTIME_EVENTS_RELATIVE_PATH,
  readRuntimeEvents,
} from "../src/webui/server/runtimeEventReader.js";

// ── Helpers ─────────────────────────────────────────────────────────────

async function tempDir(prefix = "pi-materia-runtime-events-"): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

/** Canonical enriched event with all work-item canonical fields populated. */
function makeEvent(sequence: number, overrides: Partial<EnrichedEvent> = {}): EnrichedEvent {
  return {
    type: "result.pr_created",
    severity: "info",
    message: `Event ${sequence}`,
    payload: { sequence, nested: { ok: true } },
    source: { materia: "Blackbelt-GH-PR", socketId: "Socket-7" },
    eventId: `evt-${sequence.toString().padStart(3, "0")}`,
    occurredAt: new Date(Date.UTC(2026, 5, 16, 22, 0, 0) + sequence * 1000).toISOString(),
    sequence,
    castId: "2026-06-16T22-00-00-000Z",
    socketId: "Socket-7",
    materia: "Blackbelt-GH-PR",
    materiaLabel: "GitHub PR Creator",
    visit: 2,
    itemKey: `WI-${sequence}`,
    itemLabel: `feat: implement retry ${sequence}`,
    ...overrides,
  };
}

async function writeEvents(runDir: string, events: EnrichedEvent[]): Promise<void> {
  const eventsDir = path.join(runDir, "events");
  await mkdir(eventsDir, { recursive: true });
  const file = path.join(runDir, RUNTIME_EVENTS_RELATIVE_PATH);
  const lines = events.map((event) => JSON.stringify(event)).join("\n");
  await writeFile(file, `${lines}\n`, "utf8");
}

// ── Tests ───────────────────────────────────────────────────────────────

describe("readRuntimeEvents", () => {
  const createdDirs: string[] = [];

  afterEach(() => {
    // Directories live in the OS tmp dir; tracking is just for clarity/debugging.
    createdDirs.length = 0;
  });

  test("returns an empty list when the events file is missing", async () => {
    const runDir = await tempDir();
    createdDirs.push(runDir);
    expect(await readRuntimeEvents(runDir)).toEqual([]);
  });

  test("returns an empty list when the events directory is missing", async () => {
    const runDir = await tempDir();
    createdDirs.push(runDir);
    // No events/ directory created at all.
    expect(await readRuntimeEvents(runDir)).toEqual([]);
  });

  test("returns an empty list for a non-positive limit without reading the file", async () => {
    const runDir = await tempDir();
    createdDirs.push(runDir);
    await writeEvents(runDir, [makeEvent(1), makeEvent(2)]);
    expect(await readRuntimeEvents(runDir, { limit: 0 })).toEqual([]);
  });

  test("returns newest-first ordering bounded by the default limit", async () => {
    const runDir = await tempDir();
    createdDirs.push(runDir);
    // Append-order file: 1, 2, ..., N. Newest (highest sequence) must come first.
    const appended = Array.from({ length: 5 }, (_unused, i) => makeEvent(i + 1));
    await writeEvents(runDir, appended);

    const result = await readRuntimeEvents(runDir);

    expect(result.map((event) => event.sequence)).toEqual([5, 4, 3, 2, 1]);
  });

  test("trims the oldest events when the file exceeds the limit", async () => {
    const runDir = await tempDir();
    createdDirs.push(runDir);
    const appended = Array.from({ length: 10 }, (_unused, i) => makeEvent(i + 1));
    await writeEvents(runDir, appended);

    const result = await readRuntimeEvents(runDir, { limit: 3 });

    // Newest 3 only, newest-first.
    expect(result.map((event) => event.sequence)).toEqual([10, 9, 8]);
  });

  test("respects the default bounded limit", async () => {
    const runDir = await tempDir();
    createdDirs.push(runDir);
    const appended = Array.from({ length: DEFAULT_RUNTIME_EVENT_LIMIT + 50 }, (_unused, i) => makeEvent(i + 1));
    await writeEvents(runDir, appended);

    const result = await readRuntimeEvents(runDir);

    expect(result).toHaveLength(DEFAULT_RUNTIME_EVENT_LIMIT);
    // Newest event is the last appended, and it must head the list.
    expect(result[0]?.sequence).toBe(DEFAULT_RUNTIME_EVENT_LIMIT + 50);
    expect(result.at(-1)?.sequence).toBe(51);
  });

  test("preserves canonical enriched fields and unknown fields verbatim", async () => {
    const runDir = await tempDir();
    createdDirs.push(runDir);
    const event = makeEvent(7, {
      // Forward-compatible unknown field that must survive for raw debugging.
      customMarker: "keep-me",
    } as EnrichedEvent & { customMarker: string });
    await writeEvents(runDir, [event]);

    const [result] = await readRuntimeEvents(runDir);

    // Canonical enriched fields required by the work item.
    expect(result).toMatchObject({
      eventId: "evt-007",
      type: "result.pr_created",
      severity: "info",
      message: "Event 7",
      occurredAt: event.occurredAt,
      sequence: 7,
      castId: "2026-06-16T22-00-00-000Z",
      socketId: "Socket-7",
      materia: "Blackbelt-GH-PR",
      materiaLabel: "GitHub PR Creator",
      visit: 2,
      itemKey: "WI-7",
      itemLabel: "feat: implement retry 7",
    });
    // Payload and source preserved.
    expect(result?.payload).toEqual({ sequence: 7, nested: { ok: true } });
    expect(result?.source).toEqual({ materia: "Blackbelt-GH-PR", socketId: "Socket-7" });
    // Unknown field preserved verbatim for raw debugging.
    expect((result as { customMarker?: string }).customMarker).toBe("keep-me");
  });

  test("tolerates blank lines, malformed JSON, and non-object values", async () => {
    const runDir = await tempDir();
    createdDirs.push(runDir);
    const goodFirst = makeEvent(1);
    const goodSecond = makeEvent(2);
    const goodThird = makeEvent(3);
    // Interleave malformed/partial content with valid events in append order.
    const rawLines = [
      JSON.stringify(goodFirst),
      "", // blank line
      "{ not valid json", // malformed JSON
      JSON.stringify(goodSecond),
      '"a string"', // valid JSON but not an object
      "42", // valid JSON but not an object
      "null", // valid JSON but not an object
      JSON.stringify(goodThird),
      "", // trailing blank line (partial flush simulation)
    ];
    const eventsDir = path.join(runDir, "events");
    await mkdir(eventsDir, { recursive: true });
    await writeFile(path.join(runDir, RUNTIME_EVENTS_RELATIVE_PATH), `${rawLines.join("\n")}\n`, "utf8");

    const result = await readRuntimeEvents(runDir);

    // Only the three valid object events survive, newest-first.
    expect(result.map((event) => event.sequence)).toEqual([3, 2, 1]);
  });

  test("handles a partially flushed trailing line gracefully", async () => {
    const runDir = await tempDir();
    createdDirs.push(runDir);
    const goodFirst = makeEvent(1);
    const partial = '{"eventId":"evt-002","type":"result.pr_created","mes'; // truncated mid-write
    const eventsDir = path.join(runDir, "events");
    await mkdir(eventsDir, { recursive: true });
    // Note: no trailing newline — partial line at EOF.
    await writeFile(path.join(runDir, RUNTIME_EVENTS_RELATIVE_PATH), `${JSON.stringify(goodFirst)}\n${partial}`, "utf8");

    const result = await readRuntimeEvents(runDir);

    expect(result.map((event) => event.sequence)).toEqual([1]);
  });
});
