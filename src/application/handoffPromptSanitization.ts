import { HANDOFF_TEXT_FIELD } from "../domain/handoff.js";
import { EVENT_SIDECHANNEL_FIELD } from "../domain/eventing.js";

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

/**
 * Return a parsed JSON handoff payload with the `event` side-channel removed,
 * for use as automatic prompt context.
 *
 * The runtime extracts, dispatches, and deletes `event` before storing the
 * authoritative parsed form (see docs/runtime-eventing.md §3). This helper is
 * a defensive prompt-facing guard: callers that derive prompt-facing excerpts
 * from a parsed payload strip `event` here so side-channel data can never
 * reach downstream prompts through derived strings, even if a stale or
 * unexpected payload still carries it.
 *
 * Returns the same object reference when no `event` field is present so
 * callers can detect "nothing to strip" by reference equality. When `event`
 * is present, returns a shallow clone without it (the authoritative raw JSON
 * stays preserved in `state.lastJson` and the `lastJson` artifact).
 */
export function stripEventSideChannelField<T extends Record<string, unknown>>(parsed: T): T {
  if (!Object.prototype.hasOwnProperty.call(parsed, EVENT_SIDECHANNEL_FIELD)) {
    return parsed;
  }
  const clone: Record<string, unknown> = { ...parsed };
  delete clone[EVENT_SIDECHANNEL_FIELD];
  return clone as T;
}

/**
 * Orchestration-only display markers emitted by the materia runtime UI that
 * must never become agent input via `lastAssistantText`/`lastOutput`. Each
 * pattern is anchored to a string that is internal to the materia transition
 * machinery, so legitimate agent output does not match.
 *
 * - `◆ Materia` — the renderer label for transition/status cards.
 * - `materia_prompt` / `materia materia prompt` — the hidden-prompt eventType
 *   token and its rendered prose form.
 * - `Casting **<display>**` — the transition card body in markdown form.
 * - `Casting <name> (n)` / `Casting <name> Socket-n` — the transition card
 *   body in plain form, identified by the socket ordinal/id suffix that only
 *   the card format carries.
 */
const MATERIA_DISPLAY_NOISE_PATTERNS: readonly RegExp[] = [
  /◆ Materia/,
  /\bmateria_prompt\b/,
  /\bmateria materia prompt\b/,
  /^Casting \*\*/m,
  /^Casting [^\n]*?(?:Socket-\d+|\(\d+\))/m,
];

/**
 * Whether a previous-output string is display-card/banner noise leaked from
 * the materia runtime UI (e.g. a transition card such as "Casting **X**" or
 * "◆ Materia: ..." echoed into `lastAssistantText`/`lastOutput`).
 *
 * Used by `sanitizePreviousOutput` to suppress orchestration-only strings so
 * they cannot become agent input. Returns `true` only for outputs that carry
 * a materia-internal orchestration marker, keeping legitimate text/JSON
 * previous output intact.
 */
export function isMateriaDisplayNoise(output: string): boolean {
  return MATERIA_DISPLAY_NOISE_PATTERNS.some((pattern) => pattern.test(output));
}
