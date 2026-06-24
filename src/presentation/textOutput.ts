import { HANDOFF_TEXT_FIELD } from "../handoff/handoffContract.js";

/**
 * Materia custom-message event type for renderable text payloads. The TUI
 * renderer treats these messages as clean prose (a one-way presentation layer)
 * and hides transport metadata such as workItems/satisfied/context. Emitting
 * this message never mutates cast state or the authoritative JSON envelope.
 */
export const MATERIA_TEXT_OUTPUT_EVENT_TYPE = "materia_text" as const;

/**
 * Details carried by a materia text-output message. Mirrors the existing
 * materia notification details so the shared renderer can attribute prose to
 * the producing materia/socket without exposing handoff transport fields.
 */
export interface MateriaTextOutputDetails {
  prefix: "materia";
  eventType: typeof MATERIA_TEXT_OUTPUT_EVENT_TYPE;
  socketId?: string;
  materiaName?: string;
  socketOrdinal?: number;
  itemKey?: string;
  itemLabel?: string;
}

export interface MateriaTextOutputMessage {
  customType: "pi-materia";
  content: string;
  display: true;
  details: MateriaTextOutputDetails;
}

/**
 * Extract the canonical renderable text payload from a parsed materia handoff.
 *
 * Returns the trimmed prose only when the parsed output is a plain object with
 * a non-empty string {@link HANDOFF_TEXT_FIELD}. Raw (non-JSON) text outputs
 * return undefined so plain-text materia keep their existing direct rendering
 * and are not duplicated as text-output messages.
 */
export function extractMateriaTextOutput(parsed: unknown): string | undefined {
  if (!isPlainObject(parsed)) return undefined;
  const value = parsed[HANDOFF_TEXT_FIELD];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Normalize renderable prose for TUI display without altering the authoritative
 * JSON payload. Rendering is a one-way presentation layer: this only trims
 * trailing whitespace and block edges while preserving intentional paragraph
 * breaks and indentation in the narration.
 */
export function formatMateriaTextOutputContent(text: string): string {
  return text.replace(/[ \t]+$/gm, "").trim();
}

export interface BuildMateriaTextOutputMessageInput {
  parsed: unknown;
  materiaName?: string;
  socketId?: string;
  socketOrdinal?: number;
  itemKey?: string;
  itemLabel?: string;
}

/**
 * Build the clean TUI display message for a materia text payload, or undefined
 * when the parsed handoff has no renderable text. Pure: does not mutate cast
 * state or the authoritative JSON envelope.
 */
export function buildMateriaTextOutputMessage(
  input: BuildMateriaTextOutputMessageInput,
): MateriaTextOutputMessage | undefined {
  const text = extractMateriaTextOutput(input.parsed);
  if (text === undefined) return undefined;
  return {
    customType: "pi-materia",
    content: formatMateriaTextOutputContent(text),
    display: true,
    details: {
      prefix: "materia",
      eventType: MATERIA_TEXT_OUTPUT_EVENT_TYPE,
      ...(input.socketId !== undefined ? { socketId: input.socketId } : {}),
      ...(input.materiaName !== undefined ? { materiaName: input.materiaName } : {}),
      ...(input.socketOrdinal !== undefined ? { socketOrdinal: input.socketOrdinal } : {}),
      ...(input.itemKey !== undefined ? { itemKey: input.itemKey } : {}),
      ...(input.itemLabel !== undefined ? { itemLabel: input.itemLabel } : {}),
    },
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
