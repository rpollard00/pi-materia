import type { ExecutionScope } from "../domain/executionScope.js";

const MAX_CONFLICTS = 64;
const MAX_WORKSTREAMS = 64;
const MAX_CHANGES = 512;
const MAX_PATH_LENGTH = 512;
const MAX_MESSAGE_LENGTH = 1_000;

interface ReviewRevision {
  commitId: string;
  changeId?: string;
}

interface ReviewWorkstream {
  laneId: string;
  streamIndex?: number;
  changeIds: string[];
}

interface IntegrationSummary {
  outcome: "clean" | "conflict";
  sourceCount?: number;
  effectiveBase?: ReviewRevision;
  finalTip?: ReviewRevision;
  orderedWorkstreams: ReviewWorkstream[];
  totalWorkstreamCount?: number;
  totalChangeCount?: number;
  provenanceTruncated: boolean;
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

  const sources = summary.sourceCount === undefined ? "" : ` Ordered workspace sources: ${summary.sourceCount}.`;
  const base = summary.effectiveBase
    ? `\nEffective linear base: ${formatRevision(summary.effectiveBase)}.`
    : "";
  const finalTip = summary.finalTip
    ? `\nFinal stable change: ${formatRevision(summary.finalTip)}.`
    : "";
  const workstreams = summary.orderedWorkstreams.length > 0
    ? `\nOrdered workstreams (schedule order):\n${summary.orderedWorkstreams.map((stream) => {
        const changes = stream.changeIds.length > 0 ? stream.changeIds.map((changeId) => JSON.stringify(changeId)).join(" -> ") : "no meaningful changes";
        const index = stream.streamIndex === undefined ? "" : ` [stream ${stream.streamIndex}]`;
        return `- ${JSON.stringify(stream.laneId)}${index}: ${changes}`;
      }).join("\n")}`
    : summary.totalWorkstreamCount === 0
      ? "\nOrdered workstreams: none. The linear integration is an all-no-op result."
      : "";
  const noOp = summary.totalChangeCount === 0
    ? "\nAll ordered workstreams are no-op; the final stable change is the effective base."
    : "";
  const truncation = summary.provenanceTruncated
    ? `\nReview provenance is bounded: showing at most ${MAX_WORKSTREAMS} workstreams and ${MAX_CHANGES} stable changes from ${summary.totalWorkstreamCount ?? "unknown"} workstreams and ${summary.totalChangeCount ?? "unknown"} changes.`
    : "";
  const conflictContext = summary.outcome === "conflict"
    ? summary.conflicts.length > 0
      ? `\nConflicts across the complete effective-base-to-final-tip linear range (${summary.conflicts.length}/${MAX_CONFLICTS} maximum):\n${summary.conflicts.map((conflict) => `- ${conflict.path}${conflict.message ? `: ${conflict.message}` : ""}`).join("\n")}`
      : "\nThe complete linear range reports conflicts, but no conflicted paths were supplied; inspect every revision from the effective base through the final stable change."
    : "\nThe complete linear range reports no conflicts. Spot-check the combined work and run relevant checks before accepting it.";

  return [
    "Integrated workspace review context:",
    `The active execution scope ${JSON.stringify(scope.id)} at ${JSON.stringify(scope.cwd)} contains the materialized ${summary.outcome} workspace integration as a linear history.${sources}${base}${workstreams}${finalTip}${noOp}${truncation}`,
    conflictContext,
    "Review the combined implementation in this active scope. Resolve all integration conflicts from earliest to latest using their stable change identities, then return to the rewritten final tip. Run relevant checks. Put any cross-workstream correction in one final working change. Do not rerun workstreams, publish revisions, advance bookmarks, finalize, or clean workspaces. Emit satisfied:true with concise context only when the complete linear range is conflict-free and acceptable. Emit satisfied:false with actionable context to use the ordinary retry route.",
  ].join("\n");
}

function readIntegrationSummary(value: unknown): IntegrationSummary | undefined {
  if (!isRecord(value) || (value.outcome !== "clean" && value.outcome !== "conflict")) return undefined;
  const sourceCount = safeCount(value.sourceCount);
  const effectiveBase = readRevision(value.effectiveBase);
  // Accept integrationRevision as a compatibility fallback for scopes created
  // before linear provenance was exported.
  const finalTip = readRevision(value.finalTip) ?? readRevision(value.integrationRevision);
  const rawWorkstreams = Array.isArray(value.orderedWorkstreams) ? value.orderedWorkstreams : [];
  let retainedChangeCount = 0;
  let suppliedChangeCount = 0;
  const orderedWorkstreams = rawWorkstreams.slice(0, MAX_WORKSTREAMS).flatMap((entry): ReviewWorkstream[] => {
    if (!isRecord(entry) || !nonEmpty(entry.laneId)) return [];
    const streamIndex = safeCount(entry.streamIndex);
    const suppliedChangeIds = Array.isArray(entry.changeIds) ? entry.changeIds.filter(nonEmpty) : [];
    suppliedChangeCount += suppliedChangeIds.length;
    const changeIds = suppliedChangeIds
      .slice(0, Math.max(0, MAX_CHANGES - retainedChangeCount))
      .map((id) => bounded(id, MAX_PATH_LENGTH));
    retainedChangeCount += changeIds.length;
    return [{ laneId: bounded(entry.laneId, MAX_PATH_LENGTH), ...(streamIndex !== undefined ? { streamIndex } : {}), changeIds }];
  });
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
  const totalWorkstreamCount = safeCount(value.totalWorkstreamCount) ?? sourceCount;
  const totalChangeCount = safeCount(value.totalChangeCount);
  const provenanceTruncated = value.provenanceTruncated === true
    || rawWorkstreams.length > MAX_WORKSTREAMS
    || suppliedChangeCount > retainedChangeCount;
  return {
    outcome: value.outcome,
    ...(sourceCount !== undefined ? { sourceCount } : {}),
    ...(effectiveBase ? { effectiveBase } : {}),
    ...(finalTip ? { finalTip } : {}),
    orderedWorkstreams,
    ...(totalWorkstreamCount !== undefined ? { totalWorkstreamCount } : {}),
    ...(totalChangeCount !== undefined ? { totalChangeCount } : {}),
    provenanceTruncated,
    conflicts,
  };
}

function readRevision(value: unknown): ReviewRevision | undefined {
  if (!isRecord(value) || !nonEmpty(value.commitId)) return undefined;
  return {
    commitId: bounded(value.commitId, MAX_PATH_LENGTH),
    ...(nonEmpty(value.changeId) ? { changeId: bounded(value.changeId, MAX_PATH_LENGTH) } : {}),
  };
}

function formatRevision(revision: ReviewRevision): string {
  return revision.changeId
    ? `${JSON.stringify(revision.changeId)} (commit ${JSON.stringify(revision.commitId)})`
    : JSON.stringify(revision.commitId);
}

function safeCount(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : undefined;
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
