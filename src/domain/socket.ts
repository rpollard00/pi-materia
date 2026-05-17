export interface ParsedSocketId {
  id: string;
  ordinal: number;
}

const CANONICAL_SOCKET_ID_PATTERN = /^Socket-([1-9]\d*)$/;

export const CANONICAL_SOCKET_ID_DESCRIPTION = "Socket-N, where N is a positive integer without leading zeroes";
export const SOCKET_ID_METADATA_GUIDANCE = "Socket IDs are structural graph identifiers; store human-readable names in metadata fields such as materia or utility labels.";
export const TERMINAL_ADVANCE_TARGET = "end";

export type SocketTargetSet = ReadonlySet<string> | readonly string[] | Record<string, unknown>;
export type GraphTargetClassification =
  | { kind: "socket"; target: string }
  | { kind: "terminal"; target: typeof TERMINAL_ADVANCE_TARGET }
  | { kind: "unknown"; target: string };

export function isTerminalAdvanceTarget(value: unknown): value is typeof TERMINAL_ADVANCE_TARGET {
  return value === TERMINAL_ADVANCE_TARGET;
}

/** Classify a graph target without treating arbitrary strings as valid socket ids. */
export function classifyGraphTarget(target: string, socketTargets: SocketTargetSet): GraphTargetClassification {
  if (isTerminalAdvanceTarget(target)) return { kind: "terminal", target: TERMINAL_ADVANCE_TARGET };
  if (hasSocketTarget(socketTargets, target)) return { kind: "socket", target };
  return { kind: "unknown", target };
}

/** Remap socket targets while preserving the terminal `end` sentinel unchanged. */
export function remapGraphTargetPreservingTerminal(target: string, socketIdMap: ReadonlyMap<string, string> | Record<string, string>): string {
  if (isTerminalAdvanceTarget(target)) return TERMINAL_ADVANCE_TARGET;
  return isReadonlyMap(socketIdMap) ? socketIdMap.get(target) ?? target : socketIdMap[target] ?? target;
}

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

function hasSocketTarget(socketTargets: SocketTargetSet, target: string): boolean {
  if (socketTargets instanceof Set) return socketTargets.has(target);
  if (Array.isArray(socketTargets)) return socketTargets.includes(target);
  return Object.prototype.hasOwnProperty.call(socketTargets, target);
}

function isReadonlyMap(value: ReadonlyMap<string, string> | Record<string, string>): value is ReadonlyMap<string, string> {
  return typeof (value as ReadonlyMap<string, string>).get === "function";
}
