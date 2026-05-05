import { appendFile } from "node:fs/promises";
import type { MateriaRunState } from "./types.js";

export async function appendEvent(state: MateriaRunState, type: string, data: unknown): Promise<void> {
  await appendFile(state.eventsFile, `${JSON.stringify({ ts: Date.now(), type, data })}\n`);
}

export function safePathSegment(input: string): string {
  return input.replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "") || "task";
}

let lastSafeTimestampBase = "";
let lastSafeTimestampSequence = 0;

export function safeTimestamp(): string {
  const base = new Date().toISOString().replace(/[:.]/g, "-");
  if (base === lastSafeTimestampBase) {
    lastSafeTimestampSequence += 1;
  } else {
    lastSafeTimestampBase = base;
    lastSafeTimestampSequence = 0;
  }
  return lastSafeTimestampSequence === 0 ? base : `${base}-${lastSafeTimestampSequence}`;
}
