import { readFile } from "node:fs/promises";
import path from "node:path";
import type { EnrichedEvent } from "../../domain/eventing.js";

/**
 * Relative path to the runtime events artifact under a cast run directory.
 *
 * Per docs/runtime-eventing.md §5.1, enriched runtime events are recorded at
 * `{runDir}/events/events.jsonl`. This is intentionally separate from the
 * legacy operational `{runDir}/events.jsonl` consumed by the existing
 * artifact summary (§5.3).
 */
export const RUNTIME_EVENTS_RELATIVE_PATH = path.join("events", "events.jsonl");

/**
 * Default maximum number of runtime events returned by {@link readRuntimeEvents}.
 *
 * The monitor feed is bounded so that a long-running cast with many events
 * does not flood the snapshot. Events are returned most-recent first so the
 * bound trims the oldest events, not the newest.
 */
export const DEFAULT_RUNTIME_EVENT_LIMIT = 200;

export interface RuntimeEventReaderOptions {
  /**
   * Maximum number of events to return, ordered most-recent first.
   * Defaults to {@link DEFAULT_RUNTIME_EVENT_LIMIT}. A non-positive limit
   * yields an empty array without reading the file.
   */
  limit?: number;
}

/**
 * Read enriched runtime events from `{runDir}/events/events.jsonl`.
 *
 * Behavior (per docs/runtime-eventing.md §5 and the monitor snapshot work item):
 *
 * - **Missing file → empty list.** A missing file or events directory is a
 *   normal state (no events recorded yet) and resolves to `[]`. It never throws.
 * - **Newest-first.** The artifact is append-order, so the reader walks it from
 *   the end and returns the most recent events first.
 * - **Bounded.** At most `limit` events are returned, trimming the oldest.
 * - **Full event preservation.** Each parsed object is preserved verbatim
 *   (including forward-compatible unknown fields) so the raw debugging view can
 *   show the exact recorded payload.
 * - **Malformed/partial tolerance.** Blank lines, unparseable JSON, and
 *   non-object values are skipped rather than failing the read. This keeps a
 *   partially flushed trailing line from breaking the monitor snapshot.
 *
 * @param runDir   Cast run directory containing the `events/` artifact folder.
 * @param options  Reader options (primarily the event bound).
 * @returns        Bounded newest-first list of enriched runtime events.
 */
export async function readRuntimeEvents(
  runDir: string,
  options: RuntimeEventReaderOptions = {},
): Promise<EnrichedEvent[]> {
  const limit = Math.max(0, options.limit ?? DEFAULT_RUNTIME_EVENT_LIMIT);
  if (limit === 0) return [];

  const file = path.join(runDir, RUNTIME_EVENTS_RELATIVE_PATH);
  let content: string;
  try {
    content = await readFile(file, "utf8");
  } catch {
    // Missing file/directory is a normal "no events yet" state.
    return [];
  }

  const events: EnrichedEvent[] = [];
  const lines = content.split(/\r?\n/);
  // Walk append-order newest-first and stop as soon as the bound is met so the
  // oldest events are trimmed rather than the newest.
  for (let i = lines.length - 1; i >= 0 && events.length < limit; i--) {
    const line = lines[i];
    if (!line) continue; // tolerate blank/trailing lines
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // Tolerate malformed/partial lines: skip rather than fail the snapshot.
      continue;
    }
    if (!isPlainObject(parsed)) continue; // tolerate non-object values
    // Preserve the full event object verbatim (including unknown fields).
    events.push(parsed as unknown as EnrichedEvent);
  }
  return events;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
