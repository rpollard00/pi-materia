import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { MateriaCastState } from "../types.js";

export const MATERIA_CAST_STATE_ENTRY = "pi-materia-cast-state";

export interface SessionBackedCastStateRepository {
  loadActive(ctx: ExtensionContext): MateriaCastState | undefined;
  loadById(ctx: ExtensionContext, castId: string): MateriaCastState | undefined;
  listLatest(ctx: ExtensionContext): MateriaCastState[];
  listResumable(ctx: ExtensionContext): MateriaCastState[];
  listRevivable(ctx: ExtensionContext): MateriaCastState[];
  save(pi: ExtensionAPI, state: MateriaCastState): void;
  clear(pi: ExtensionAPI, state: MateriaCastState, reason?: string): MateriaCastState;
}

export function createSessionBackedCastStateRepository(): SessionBackedCastStateRepository {
  return {
    loadActive: loadActiveCastState,
    loadById: loadCastStateById,
    listLatest: listLatestCastStates,
    listResumable: listResumableCastStates,
    listRevivable: listRevivableCastStates,
    save: saveCastState,
    clear: clearCastState,
  };
}

export function loadCastStateById(ctx: ExtensionContext, castId: string): MateriaCastState | undefined {
  const requested = castId.trim();
  if (!requested) return undefined;
  return listLatestCastStates(ctx).find((state) => state.castId === requested);
}

export function listLatestCastStates(ctx: ExtensionContext): MateriaCastState[] {
  const entries = ctx.sessionManager.getBranch();
  const seenCastIds = new Set<string>();
  const states: MateriaCastState[] = [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== "custom" || entry.customType !== MATERIA_CAST_STATE_ENTRY || !entry.data) continue;
    const state = cloneCastState(entry.data as MateriaCastState);
    if (!state.castId || seenCastIds.has(state.castId)) continue;
    seenCastIds.add(state.castId);
    states.push(state);
  }
  return states.sort(compareCastStatesNewestFirst);
}

export function listResumableCastStates(ctx: ExtensionContext): MateriaCastState[] {
  return listLatestCastStates(ctx).filter(isResumableCastState);
}

export function listRevivableCastStates(ctx: ExtensionContext): MateriaCastState[] {
  return listResumableCastStates(ctx).filter(isRevivableCastState);
}

export function loadActiveCastState(ctx: ExtensionContext): MateriaCastState | undefined {
  const entries = ctx.sessionManager.getBranch();
  const seenCastIds = new Set<string>();
  let latest: MateriaCastState | undefined;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== "custom" || entry.customType !== MATERIA_CAST_STATE_ENTRY || !entry.data) continue;
    const state = cloneCastState(entry.data as MateriaCastState);
    if (!latest) latest = state;
    if (seenCastIds.has(state.castId)) continue;
    seenCastIds.add(state.castId);
    if (state.active) return state;
  }
  return latest;
}

export function saveCastState(pi: ExtensionAPI, state: MateriaCastState): void {
  state.updatedAt = Date.now();
  pi.appendEntry(MATERIA_CAST_STATE_ENTRY, cloneCastState(state));
}

export function clearCastState(pi: ExtensionAPI, state: MateriaCastState, reason = "aborted"): MateriaCastState {
  state.active = false;
  state.awaitingResponse = false;
  state.socketState = "failed";
  state.phase = reason === "aborted" ? "failed" : state.phase;
  state.failedReason = reason;
  state.updatedAt = Date.now();
  state.runState.endedAt ??= Date.now();
  saveCastState(pi, state);
  return state;
}

function isResumableCastState(state: MateriaCastState): boolean {
  return !state.active && state.phase !== "complete" && state.socketState !== "complete" && (state.phase === "failed" || state.socketState === "failed");
}

function isRevivableCastState(state: MateriaCastState): boolean {
  if (!isResumableCastState(state)) return false;
  const exhaustion = state.recoveryExhaustion;
  if (!exhaustion || exhaustion.kind !== "same_socket_recovery_exhausted" || !exhaustion.key) return false;
  if (!exhaustion.failedReason || exhaustion.failedReason !== state.failedReason) return false;
  const allowance = state.recoveryAllowances?.[exhaustion.key];
  return Boolean(
    allowance &&
    Number.isSafeInteger(allowance.originalMaxAttempts) && allowance.originalMaxAttempts > 0 &&
    Number.isSafeInteger(allowance.effectiveMaxAttempts) && allowance.effectiveMaxAttempts >= allowance.originalMaxAttempts &&
    Number.isSafeInteger(allowance.reviveCount) && allowance.reviveCount >= 0
  );
}

function compareCastStatesNewestFirst(a: MateriaCastState, b: MateriaCastState): number {
  const byUpdatedAt = safeTime(b.updatedAt) - safeTime(a.updatedAt);
  if (byUpdatedAt !== 0) return byUpdatedAt;
  const byStartedAt = safeTime(b.startedAt) - safeTime(a.startedAt);
  if (byStartedAt !== 0) return byStartedAt;
  return b.castId.localeCompare(a.castId);
}

function safeTime(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function cloneCastState(state: MateriaCastState): MateriaCastState {
  return structuredClone(state) as MateriaCastState;
}
