import type { MateriaLoopConfig, MateriaLoopExitRouteConfig, MateriaLoopExitRouteCondition } from "../types.js";

export interface LoopExitRouteResolutionOptions {
  /**
   * Socket id of the loop member that is completing as the loop exit. When not
   * provided, loop.exit.from is used as the configured exit source if set.
   */
  from?: string;
  /**
   * Canonical loop completion outcome. Undefined means the outcome is unknown
   * or not applicable, so only unconditional loop-exit routes may be selected.
   */
  satisfied?: boolean;
}

/**
 * Resolve the single loop-owned exit route to follow after loop completion.
 *
 * Precedence is intentionally centralized here so runtime, editor previews, and
 * UI labels do not duplicate conditional semantics:
 * - satisfied === true: `satisfied`, then `always`, then no route.
 * - satisfied === false: `not_satisfied`, then `always`, then no route.
 * - satisfied === undefined: `always`, then no route.
 *
 * The resolver only reads the canonical `satisfied` boolean supplied by the
 * caller. It never infers outcomes from non-canonical payload fields. Validation enforces one route per condition per
 * loop-exit source; if unvalidated metadata is passed, the first route in
 * metadata order for the selected condition/source is returned deterministically.
 */
export function resolveLoopExitRoute(loop: Pick<MateriaLoopConfig, "exit" | "exits"> | undefined, options: LoopExitRouteResolutionOptions = {}): MateriaLoopExitRouteConfig | undefined {
  const routes = loop?.exits ?? [];
  if (routes.length === 0) return undefined;

  const from = options.from ?? loop?.exit?.from;
  const candidates = from ? routes.filter((route) => route.from === from) : routes;
  if (candidates.length === 0) return undefined;

  for (const condition of routeConditionPrecedence(options.satisfied)) {
    const route = candidates.find((candidate) => candidate.condition === condition);
    if (route) return route;
  }
  return undefined;
}

function routeConditionPrecedence(satisfied: boolean | undefined): MateriaLoopExitRouteCondition[] {
  if (satisfied === true) return ["satisfied", "always"];
  if (satisfied === false) return ["not_satisfied", "always"];
  return ["always"];
}
