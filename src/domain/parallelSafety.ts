import type { DomainIssue, DomainResult } from "./result.js";

/** Minimal materia shape needed by the child-capability validator. */
export interface ParallelSafetyMateriaLike {
  id?: string;
  type?: "agent" | "utility" | string;
  multiTurn?: boolean;
  /** Trusted permission for concurrent child execution, not an isolation guarantee. */
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

/** Validate one materia definition for concurrent child execution. */
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
      message: `materia ${JSON.stringify(materiaId)} is multi-turn/user-interactive and cannot execute concurrently in a parallel child`,
    });
    return issues;
  }

  if (materia.parallelSafe !== true) {
    issues.push({
      path: `${path}.parallelSafe`,
      message: `materia ${JSON.stringify(materiaId)} must explicitly declare parallelSafe: true for concurrent child execution; this permission does not guarantee cwd isolation, and multiple scopes may share one cwd`,
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

/** Return whether a referenced definition can run in a parallel child. */
export function isParallelSafeMateria(materiaId: string, materia: ParallelSafetyMateriaLike | undefined): boolean {
  return parallelSafetyIssuesForMateria(materiaId, materia).length === 0;
}

/** Short alias for callers that use the feature's child-safe terminology. */
export const validateChildMateriaParallelSafety = validateParallelSafeMateria;
