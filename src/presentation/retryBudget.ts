import { isValidRecoveryAllowance, recoveryIdentityKey } from "../application/recoveryPolicy.js";
import { canonicalOutgoingEdges } from "../graph/graphValidation.js";
import { loopSockets, resolvedPipelineSockets } from "../loadout/loadoutAccessors.js";
import { currentCastSocketId } from "../runtime/castStateAccessors.js";
import { currentTaskAttempt } from "../runtime/sessionState.js";
import { effectiveResolvedSocketConfig } from "../runtime/resolvedMateria.js";
import type { MateriaCastState } from "../types.js";

/**
 * Optional retry budget for the current Materia step, expressed as a 1-based
 * current attempt against an effective maximum. Designed for compact status
 * widget rendering such as `⟳ 1/3`.
 */
export interface MateriaRetryBudget {
  /** 1-based current attempt; the first attempt for a step is 1. */
  current: number;
  /** Effective maximum attempts for the current step. */
  max: number;
}

/**
 * Pure status-widget helper that derives an optional retry budget for the
 * current Materia step from the active cast state. Runtime allowance state is
 * preferred over guessing, and no maximum is ever invented.
 *
 * Resolution order:
 *  1. Same-socket recovery — an in-flight agent turn is being retried in place.
 *     Uses the active recovery key, {@link MateriaCastState.recoveryAttempts},
 *     and the revived-aware {@link MateriaCastState.recoveryAllowances}
 *     effective max.
 *  2. Graph rework retries — the current socket is re-entered via a bounded
 *     loop edge. Uses the current socket/item attempt and the relevant retry
 *     edge allowance effective limit, falling back to the edge's configured
 *     {@code maxTraversals} when no revived allowance exists.
 *
 * Returns `undefined` when no configured or effective maximum is available.
 */
export function deriveRetryBudget(state: MateriaCastState): MateriaRetryBudget | undefined {
  return deriveSameSocketRecoveryBudget(state) ?? deriveReworkEdgeBudget(state);
}

/**
 * Same-socket recovery budget: `recoveryAttempts[key] + 1` against the revived
 * allowance's effective max. Exposed so renderers/tests can isolate this branch.
 */
export function deriveSameSocketRecoveryBudget(state: MateriaCastState): MateriaRetryBudget | undefined {
  // No recovery allowances means no active same-socket recovery. Short-circuit before
  // computing the recovery key, which assumes a fully populated cast state (pipeline,
  // visits) and is invoked here from the always-on status widget renderer.
  if (!state.recoveryAllowances) return undefined;
  const key = recoveryIdentityKey(state);
  const allowance = state.recoveryAllowances[key];
  if (!isValidRecoveryAllowance(allowance)) return undefined;
  // recoveryAttempts[key] counts completed retries; the in-flight attempt is 1-based,
  // so the first attempt for a step renders as 1/max.
  const current = (state.recoveryAttempts?.[key] ?? 0) + 1;
  return { current, max: allowance.effectiveMaxAttempts };
}

/**
 * Graph rework budget: the current socket/item attempt against the relevant
 * retry edge allowance effective limit, falling back to the edge's configured
 * {@code maxTraversals}. Exposed so renderers/tests can isolate this branch.
 */
export function deriveReworkEdgeBudget(state: MateriaCastState): MateriaRetryBudget | undefined {
  const socketId = currentCastSocketId(state);
  if (!socketId) return undefined;
  const max = relevantReworkEdgeMax(state, socketId);
  if (max === undefined) return undefined;
  // The current socket/item attempt is 1-based; floor at 1 so a first attempt is 1/max.
  const current = Math.max(1, currentTaskAttempt(state) ?? 1);
  return { current, max };
}

/**
 * Effective maximum for the intra-loop rework edge that re-enters the current
 * socket. Prefers a revived edge allowance's effective limit and falls back to
 * the configured {@code maxTraversals}. Returns undefined when the current
 * socket is not in a loop or no bounded rework edge exists.
 */
function relevantReworkEdgeMax(state: MateriaCastState, socketId: string): number | undefined {
  const members = activeLoopMemberSet(state, socketId);
  if (members.size === 0) return undefined;
  const sockets = resolvedPipelineSockets(state.pipeline);
  let revived: number | undefined;
  let configured: number | undefined;
  for (const memberId of members) {
    const socket = sockets[memberId];
    if (!socket) continue;
    for (const edge of canonicalOutgoingEdges(effectiveResolvedSocketConfig(socket))) {
      // A rework edge targets the current socket, re-entering it within its loop.
      if (edge.to !== socketId) continue;
      const effectiveLimit = state.edgeAllowances?.[edgeKey(memberId, edge.to)]?.effectiveLimit;
      if (typeof effectiveLimit === "number" && Number.isSafeInteger(effectiveLimit) && effectiveLimit > 0) {
        revived = revived === undefined ? effectiveLimit : Math.max(revived, effectiveLimit);
      }
      const maxTraversals = edge.maxTraversals;
      if (typeof maxTraversals === "number" && Number.isSafeInteger(maxTraversals) && maxTraversals > 0) {
        configured = configured === undefined ? maxTraversals : Math.max(configured, maxTraversals);
      }
    }
  }
  // Prefer the revived effective limit; fall back to the configured traversal cap.
  return revived ?? configured;
}

function activeLoopMemberSet(state: MateriaCastState, socketId: string): Set<string> {
  const loops = Object.values(state.pipeline?.loops ?? {});
  const loop = loops.find((candidate) => loopSockets(candidate).includes(socketId));
  return loop ? new Set(loopSockets(loop)) : new Set();
}

function edgeKey(from: string, to: string): string {
  return `${from}->${to}`;
}
