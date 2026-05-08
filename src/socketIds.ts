export interface ParsedSocketId {
  id: string;
  ordinal: number;
}

const CANONICAL_SOCKET_ID_PATTERN = /^Socket-([1-9]\d*)$/;

export const CANONICAL_SOCKET_ID_DESCRIPTION = "Socket-N, where N is a positive integer without leading zeroes";
export const SOCKET_ID_METADATA_GUIDANCE = "Socket IDs are structural graph identifiers; store human-readable labels or materia names in metadata fields such as label, materia, loop label, or utility label.";

export function parseCanonicalSocketId(value: string): ParsedSocketId | undefined {
  const match = CANONICAL_SOCKET_ID_PATTERN.exec(value);
  if (!match) return undefined;
  return { id: value, ordinal: Number(match[1]) };
}

export function isCanonicalSocketId(value: unknown): value is string {
  return typeof value === "string" && parseCanonicalSocketId(value) !== undefined;
}

export function formatInvalidSocketIdMessage(value: unknown, source: string): string {
  const display = typeof value === "string" ? `\"${value}\"` : String(value);
  return `Invalid socket id ${display} referenced by ${source}. Expected ${CANONICAL_SOCKET_ID_DESCRIPTION}. ${SOCKET_ID_METADATA_GUIDANCE}`;
}

export function assertCanonicalSocketId(value: unknown, source: string): asserts value is string {
  if (!isCanonicalSocketId(value)) throw new Error(formatInvalidSocketIdMessage(value, source));
}
