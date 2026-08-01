import type { DomainIssue, DomainResult } from "./result.js";

/** Minimal materia shape needed by the child-capability validator. */
export interface ParallelSafetyMateriaLike {
  id?: string;
  type?: "agent" | "utility" | string;
  multiTurn?: boolean;
  /** Custom utility/agent declarations are trusted configuration, not a sandbox. */
  parallelSafe?: boolean;
  utility?: string;
  command?: string[];
  script?: { name?: string };
  /** Compatibility for integrations that model interactivity separately from multiTurn. */
  interactive?: boolean;
  userInteractive?: boolean;
  requiresUserInput?: boolean;
}

export interface ParallelChildSocketCapability {
  socketId: string;
  materiaId: string;
  materia?: ParallelSafetyMateriaLike;
}

/**
 * Built-in operations whose behavior is parent/repository scoped. These are
 * denied even when a caller supplies a permissive custom declaration: a
 * declaration opts unknown/custom code into the workspace-local contract, but
 * does not turn a known parent integration operation into a lane operation.
 */
export const KNOWN_PARENT_SHARED_MATERIA_IDS = new Set([
  "blackbelt-bootstrap",
  "blackbelt-maintain",
  "blackbelt-gh-pr",
  "blackbelt-ado-pr",
  "mime-bootstrap",
  "mime-maintain",
  "mime-gh-pr",
  "mime-ado-pr",
  "ignore-artifacts",
  "maintain",
  "gitmaintain",
  "git-maintain",
  "bookmark",
  "publish",
  "integration",
  "integration-eval",
  "parent-integration",
  "fan-in",
  "resolver",
]);

/** Known aliases/scripts are checked as well as materia ids because users may rename definitions. */
const KNOWN_PARENT_SHARED_UTILITY_ALIASES = new Set([
  "bookmark",
  "bookmark-advance",
  "integrate",
  "parent-integrate",
  "parent-integration",
  "publish",
  "pull-request",
]);
const KNOWN_PARENT_SHARED_SCRIPT_NAMES = new Set([
  "blackbelt-bootstrap.mjs",
  "blackbelt-maintain.mjs",
  "blackbelt-gh-pr.mjs",
  "blackbelt-ado-pr.mjs",
  "mime-bootstrap.mjs",
  "mime-maintain.mjs",
  "mime-gh-pr.mjs",
  "mime-ado-pr.mjs",
  "ensure-ignored.mjs",
]);

/** Validate one materia definition for use in a parallel child workspace. */
export function validateParallelSafeMateria(
  materiaId: string,
  materia: ParallelSafetyMateriaLike | undefined,
  path = `materia.${materiaId}`,
): DomainResult<ParallelSafetyMateriaLike> {
  const issues = parallelSafetyIssuesForMateria(materiaId, materia, path);
  return issues.length > 0 ? { ok: false, issues } : { ok: true, value: materia ?? { id: materiaId } };
}

/** Return all diagnostics for one child materia without throwing on malformed config. */
export function parallelSafetyIssuesForMateria(
  materiaId: string,
  materia: ParallelSafetyMateriaLike | undefined,
  path = `materia.${materiaId}`,
): DomainIssue[] {
  if (!materia || typeof materia !== "object") {
    return [{ path, message: `parallel child references unknown materia ${JSON.stringify(materiaId)}` }];
  }

  const issues: DomainIssue[] = [];
  if (materia.multiTurn === true || materia.interactive === true || materia.userInteractive === true || materia.requiresUserInput === true) {
    issues.push({
      path: `${path}.multiTurn`,
      message: `materia ${JSON.stringify(materiaId)} is multi-turn/user-interactive and cannot execute in a parallel child workspace`,
    });
    return issues;
  }

  if (isKnownParentSharedOperation(materiaId, materia)) {
    issues.push({
      path,
      message: `materia ${JSON.stringify(materiaId)} is a known parent-shared operation (bookmark advancement, publishing, or parent integration) and must remain in the parent workflow`,
    });
    return issues;
  }

  if (materia.parallelSafe !== true) {
    issues.push({
      path: `${path}.parallelSafe`,
      message: `materia ${JSON.stringify(materiaId)} must explicitly declare parallelSafe: true for workspace-local parallel child execution`,
    });
  }
  return issues;
}

/** Validate every selected socket and retain socket-specific paths for graph diagnostics. */
export function validateParallelChildCapabilities(
  sockets: readonly ParallelChildSocketCapability[],
  path = "parallel child",
): DomainResult<readonly ParallelChildSocketCapability[]> {
  const issues: DomainIssue[] = [];
  for (const [index, socket] of sockets.entries()) {
    if (!socket || typeof socket !== "object") {
      issues.push({ path: `${path}.sockets.${index}`, message: "parallel child socket capability entry must be an object" });
      continue;
    }
    const socketPath = `${path}.sockets.${index}(${socket.socketId})`;
    issues.push(...parallelSafetyIssuesForMateria(socket.materiaId, socket.materia, socketPath));
  }
  return issues.length > 0 ? { ok: false, issues } : { ok: true, value: sockets };
}

export function isKnownParentSharedOperation(materiaId: string, materia: ParallelSafetyMateriaLike): boolean {
  const id = materiaId.trim().toLowerCase();
  if (KNOWN_PARENT_SHARED_MATERIA_IDS.has(id)) return true;
  const utility = typeof materia.utility === "string" ? materia.utility.trim().toLowerCase() : "";
  const script = typeof materia.script?.name === "string" ? materia.script.name.trim().toLowerCase() : "";
  return KNOWN_PARENT_SHARED_UTILITY_ALIASES.has(utility) || KNOWN_PARENT_SHARED_SCRIPT_NAMES.has(script);
}

/** Return whether a referenced definition can run in a parallel child. */
export function isParallelSafeMateria(materiaId: string, materia: ParallelSafetyMateriaLike | undefined): boolean {
  return parallelSafetyIssuesForMateria(materiaId, materia).length === 0;
}

/** Short alias for callers that use the feature's child-safe terminology. */
export const validateChildMateriaParallelSafety = validateParallelSafeMateria;
