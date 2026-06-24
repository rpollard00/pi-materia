import { HANDOFF_TEXT_FIELD } from "../domain/handoff.js";

/**
 * Re-stringify a parsed JSON handoff payload without its renderable `text`
 * field, for use as automatic prompt context (e.g. the synthetic "Previous
 * output" section or captured rework-feedback excerpts).
 *
 * Renderable text must reach following materia only through explicit
 * assignment (e.g. `assign: { "prNotes": "$.text" }`) or templating, never as
 * default automatic context. Callers that derive prompt-facing excerpts from a
 * parsed handoff payload therefore strip `text` here. The authoritative raw
 * JSON (including `text`) is preserved separately in `state.lastJson` and the
 * `lastJson` artifact for debugging and replay; this helper only affects the
 * derived prompt-facing string.
 *
 * Returns `undefined` when `text` was the only field so callers can omit an
 * empty/noisy section instead of emitting `{}`.
 */
export function stripRenderableTextField(parsed: Record<string, unknown>): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(parsed, HANDOFF_TEXT_FIELD)) {
    return JSON.stringify(parsed);
  }
  const clone: Record<string, unknown> = { ...parsed };
  delete clone[HANDOFF_TEXT_FIELD];
  return Object.keys(clone).length > 0 ? JSON.stringify(clone) : undefined;
}
