import { appendFile } from "node:fs/promises";
import type { MateriaRunState } from "./types.js";

export async function appendEvent(state: MateriaRunState, type: string, data: unknown): Promise<void> {
  await appendFile(state.eventsFile, `${JSON.stringify({ ts: Date.now(), type, data })}\n`);
}

export function safePathSegment(input: string): string {
  return input.replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "") || "task";
}

export function safeTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}
