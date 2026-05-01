import { appendFile } from "node:fs/promises";
export async function appendEvent(state, type, data) {
    await appendFile(state.eventsFile, `${JSON.stringify({ ts: Date.now(), type, data })}\n`);
}
export function safePathSegment(input) {
    return input.replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "") || "task";
}
export function safeTimestamp() {
    return new Date().toISOString().replace(/[:.]/g, "-");
}
