import type { ExecutionScope } from "../domain/executionScope.js";

const MAX_CONFLICTS = 64;
const MAX_PATH_LENGTH = 512;
const MAX_MESSAGE_LENGTH = 1_000;

interface IntegrationSummary {
  outcome: "clean" | "conflict";
  sourceCount?: number;
  revision?: { commitId: string; changeId?: string };
  conflicts: Array<{ path: string; message?: string }>;
}

/**
 * Build repository-adapter context only when a utility has activated an
 * integrated execution scope. Core scope handling remains workspace-neutral.
 */
export function syntheticIntegrationReviewContext(scope: ExecutionScope | undefined): string | undefined {
  if (!scope) return undefined;
  const summary = readIntegrationSummary(scope.state.jjWorkspaceIntegration);
  if (!summary) return undefined;

  const revision = summary.revision?.commitId ? ` Integration revision: ${JSON.stringify(summary.revision.commitId)}.` : "";
  const sources = summary.sourceCount === undefined ? "" : ` Ordered workspace sources: ${summary.sourceCount}.`;
  const conflictContext = summary.outcome === "conflict"
    ? summary.conflicts.length > 0
      ? `\nBounded conflict context (${summary.conflicts.length}/${MAX_CONFLICTS} maximum):\n${summary.conflicts.map((conflict) => `- ${conflict.path}${conflict.message ? `: ${conflict.message}` : ""}`).join("\n")}`
      : "\nThe integration reports conflicts, but no conflicted paths were supplied; inspect the active scope for the current conflict state."
    : "\nThe integration reports no conflicts. Spot-check the combined work and run relevant checks before accepting it.";

  return [
    "Integrated workspace review context:",
    `The active execution scope ${JSON.stringify(scope.id)} at ${JSON.stringify(scope.cwd)} contains the materialized ${summary.outcome} workspace integration.${revision}${sources}`,
    conflictContext,
    "Review the combined implementation in this active scope. Resolve all integration conflicts when present; otherwise inspect the merge for cross-branch defects. You may edit files and run relevant checks, but do not rerun branches, publish revisions, or clean workspaces. Emit satisfied:true with concise context only when the integration is conflict-free and acceptable. Emit satisfied:false with actionable context to use the ordinary retry route.",
  ].join("\n");
}

function readIntegrationSummary(value: unknown): IntegrationSummary | undefined {
  if (!isRecord(value) || (value.outcome !== "clean" && value.outcome !== "conflict")) return undefined;
  const sourceCount = Number.isSafeInteger(value.sourceCount) && (value.sourceCount as number) >= 0
    ? value.sourceCount as number
    : undefined;
  const revision = isRecord(value.integrationRevision) && nonEmpty(value.integrationRevision.commitId)
    ? {
        commitId: bounded(value.integrationRevision.commitId, MAX_PATH_LENGTH),
        ...(nonEmpty(value.integrationRevision.changeId) ? { changeId: bounded(value.integrationRevision.changeId, MAX_PATH_LENGTH) } : {}),
      }
    : undefined;
  const details = Array.isArray(value.conflictDetails) ? value.conflictDetails : [];
  const detailByPath = new Map<string, string>();
  for (const detail of details.slice(0, MAX_CONFLICTS)) {
    if (!isRecord(detail) || !nonEmpty(detail.path) || !nonEmpty(detail.message)) continue;
    detailByPath.set(bounded(detail.path, MAX_PATH_LENGTH), bounded(detail.message, MAX_MESSAGE_LENGTH));
  }
  const paths = Array.isArray(value.conflictedPaths) ? value.conflictedPaths : [];
  const conflicts = paths
    .filter(nonEmpty)
    .slice(0, MAX_CONFLICTS)
    .map((path) => {
      const boundedPath = bounded(path, MAX_PATH_LENGTH);
      return { path: boundedPath, ...(detailByPath.get(boundedPath) ? { message: detailByPath.get(boundedPath) } : {}) };
    });
  for (const [path, message] of detailByPath) {
    if (conflicts.length >= MAX_CONFLICTS) break;
    if (!conflicts.some((conflict) => conflict.path === path)) conflicts.push({ path, message });
  }
  return { outcome: value.outcome, ...(sourceCount !== undefined ? { sourceCount } : {}), ...(revision ? { revision } : {}), conflicts };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function bounded(value: string, max: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}…`;
}
