/**
 * Shared semantic guardrails for every parallel-schedule authoring surface.
 * Keep transport-specific instructions separate so direct JSON and tool-backed
 * finalization cannot disagree about how streams execute or should be divided.
 */
export const PARALLEL_PLANNING_GUARDRAILS = [
  "Every stream starts concurrently from the same pinned baseline; stream order controls deterministic fan-in and must not be used to express execution dependencies.",
  "Prioritize independence over balancing stream sizes. Keep shared contracts, dependent or order-sensitive work, and work likely to overlap in the same files or modules in one stream, preserving required intra-stream order. Avoid broad cross-stream ownership; use a single stream when the work cannot be separated safely.",
  "Use unique, stable, descriptive stream names.",
] as const;

export const PARALLEL_SCHEDULE_COVERAGE_GUIDANCE =
  "Cover every final work-item index exactly once";

/** Build qualified-planner guidance while varying only the submission mechanism. */
export function formatParallelPlanningGuidance(submissionInstruction: string): string {
  return [
    "Intrinsic parallel planning is enabled for this generator.",
    ...PARALLEL_PLANNING_GUARDRAILS,
    `${submissionInstruction} ${PARALLEL_SCHEDULE_COVERAGE_GUIDANCE}; do not copy or submit stream metadata as work items.`,
  ].join("\n");
}
