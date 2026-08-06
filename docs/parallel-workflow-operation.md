# Parallel workflow operation

Parallel generation is an optional app-level capability. It is workspace neutral: core schedules scoped child casts and returns ordered outputs/exports, while utilities opt into repository or workspace behavior. Read the normative [intrinsic parallel generation contract](parallel-loop-orchestration.md) first.

## Configure and author

Set a positive app default:

```json
{ "parallelism": { "maxConcurrency": 4 } }
```

Mark a generator materia with both capabilities:

```json
{
  "type": "agent",
  "generator": true,
  "parallel": true,
  "parse": "json"
}
```

The generator's single deterministic path must reach one consuming loop. Sockets between it and that loop form the branch prelude and run once per stream. Every prelude and loop materia must be non-interactive and declare `parallelSafe: true`. A loop may set only an optional `{ "parallel": { "maxConcurrency": 2 } }` override; omit it to use the app default.

Do not add a schedule normalizer, authored lane sockets, fan-in routes, workspace mode, plan input, or failure policy. Core injects planning instructions, validates `parallelSchedule`, derives the region, queues streams, and creates the barrier.

## Select interactive or non-interactive planning

Use `Parallel-Interactive` when you want to review and refine the plan with the operator before any child work starts:

```text
/materia loadout Parallel-Interactive
/materia cast <request>
```

Planning remains conversational until `/materia continue`. Review or revise the proposed work items and stream partition with ordinary messages; the cast does not advance to the parallel region while the planner is waiting for refinement. Run `/materia continue` only when the plan is ready to finalize. That finalization turn produces the definitive `workItems` and `parallelSchedule`; only after both are produced and validated do child streams launch.

`Parallel-Experimental` is the non-interactive variant. It does not pause for conversational planning or operator approval:

```text
/materia loadout Parallel-Experimental
/materia cast <request>
```

Its planner proceeds directly to the final structured plan, after which the runtime validates the schedule and starts the derived child streams. Choose it for an autonomous cast; choose `Parallel-Interactive` when the work breakdown needs a conversational review first.

### Plan independent streams

Every stream starts concurrently from the same pinned cast baseline. The order of `parallelSchedule.streams` controls deterministic fan-in after execution; it does **not** make a later stream depend on an earlier stream's output. Put shared contracts, dependent or order-sensitive changes, and work likely to touch the same files or modules in one stream. Keep cross-stream ownership narrow and prefer genuine independence over evenly balanced streams. Use one stream when the work cannot be partitioned safely.

## Choose filesystem behavior deliberately

Detached execution scopes may share the same cwd. This is useful for read-only or otherwise concurrency-safe work, but it is **not isolation**. Concurrent writes can race even though scope ids and scope-local state differ. `parallelSafe: true` is a trust declaration, not a lock or sandbox.

Use a prelude utility to replace each branch scope when isolation is required. The shipped jj composition is:

```text
Parallel-Plan -> Spawn-JJ-Workspace -> [Build, Auto-Eval, Blackbelt-Maintain]
              -> intrinsic barrier -> Integrate-JJ-Workspaces
              -> Integration-Review -> Finalize-JJ-Workspace
```

Run it with:

```text
/materia loadout Parallel-Experimental
/materia cast <request>
```

### Regular generator with one workspace

Workspace composition does not require parallelism. Place `Spawn-JJ-Workspace` once after an ordinary `generator: true` materia and before its sequential consuming loop. All items then use one replacement active scope. After the loop, pass its export to `Integrate-JJ-Workspaces`, review the materialized scope, and finalize it. This uses the same scope-transition path as the parallel loadout.

### Parallel generator with one workspace per stream

Place `Spawn-JJ-Workspace` in the derived branch prelude. Each stream creates one owned, bookmarkless lane workspace and executes all its ordered items there. The base working copy and original cast bookmark remain unchanged during branch work. The utility exports ownership, integration, and cleanup data; parallel core transports those values without understanding jj.

## Runtime expectations

- Streams queue in normalized schedule order. At most the effective concurrency bound are live.
- Items remain sequential within a stream and keep their original work-item indexes.
- The parent token budget is aggregate; parallelism does not raise it. Real cumulative usage deltas are checkpointed and counted once.
- Message, token, tool, and session callbacks are observational: they neither save parent state nor become generic lane events.
- One failed branch does not immediately discard sibling diagnostics. The barrier waits for all terminal branches, then fails without partial fan-in.
- Successful barrier output is ordered by schedule, never completion time. Generic branch state is not merged.
- Empty plans complete without starting children or a normalization utility.

If runtime eventing and a positive heartbeat interval are enabled, the single parent-cast `lifecycle.heartbeat` continues while the barrier is waiting. Child lanes do not each start a heartbeat. A child terminal marker is consumed once, but final resource retirement may wait for child process close so bounded captures and parsers are flushed. Process exit without an explicit accepted terminal result is not accepted fan-in evidence.

### Durable checkpoints and retirement

Expect parent cast-state writes only at durable boundaries: plan/run creation, launch or resume, lane status change, real cumulative usage delta, terminal result, cancellation, budget failure, and barrier phase change. High-volume observational callbacks update only transient progress until one of those boundaries. Therefore message volume should not increase parent state-save or lane artifact-event counts.

After terminal evidence and lane state are durable, observers are unsubscribed and child process/listener/parser/capture references are released. Barrier settlement also clears accepted child records and coordinator event tails, usage maps, prepared graphs, terminal queues, and parent references. Failed/interrupted lanes keep only the recovery identity, paths, scope, usage baseline, and watermark needed to resume. Late callbacks are generation-isolated and cannot modify a subsequent run using the same dispatcher.

### Interpret concurrency evidence

“Running” describes coordinator state, not one kind of work. Keep these observations separate when diagnosing apparent alternation:

- **Coordinator slot occupancy.** The effective `maxConcurrency` bounds live child lanes. The TUI aggregate row (`running/maxConcurrency`) counts lanes from launch until terminal retirement, including time spent in a prelude, waiting for a model or tool, flushing a child process, or otherwise making no visible file change. A full `2/2` therefore proves that the dispatch bound is occupied; it does not prove that two provider requests or two tools are executing at the same instant.
- **Child socket-stage overlap.** A lane's active stage is the validated materia label from its immutable compiled child loadout, such as `Spawn-JJ-Workspace`, `Build`, `Auto-Eval` (Eval), or `Blackbelt-Maintain` (Maintain). Its transition time is the child event's stage-entry timestamp, not a model-call or commit timestamp. Overlapping stage transitions and interleaved child evidence show that child programs are progressing concurrently even when their model/tool or repository activity is staggered. A transition timestamp brackets a stage with the next transition or terminal evidence; it is not a duration measurement.
- **Model and tool activity.** A stage says which child socket is active, not whether its provider call has started, completed, or been scheduled independently of another provider call. Session history and the capped child stdout/stderr captures are the evidence for model turns, tool invocations, retries, and waits. Provider queues, tool implementations, host resources, and network latency can serialize that activity without the coordinator serializing lanes; do not assign a provider or scheduler root cause from slot occupancy alone.
- **jj working-copy changes.** Each lane workspace has its own jj working-copy commit (`@`). Edits belong to that workspace's current `@`; they are not a separate Git-style staged set waiting for a commit. `Blackbelt-Maintain` checks the working copy, runs `jj describe` on that commit using the item title, and then runs `jj new` to open a new empty working commit. A changed `jj log` entry is therefore evidence of a workspace checkpoint, not by itself evidence that a whole lane was the only task running.
- **Serialized jj mutations.** Child work can overlap while jj commands mutate shared repository metadata. Workspace registration, `describe`, `new`, bookmark movement, and later integration/finalization may contend on repository locks or are intentionally ordered by the workflow. Minute-scale staggered jj changes are consequently a valid symptom to investigate, not proof of a provider or dispatcher defect. Correlate each change with the lane's stage, child artifacts, and terminal timing before concluding that execution was serialized.

Use the live stages to localize the wait:

- **Queued:** no child slot has been claimed; a full aggregate row points to the coordinator bound or an earlier terminal/refill boundary.
- **Prelude:** a slot is occupied, but per-item loop progress remains `0/total`. In the shipped jj loadout this includes `Spawn-JJ-Workspace`; delays here implicate workspace setup or child launch rather than Build/Eval work.
- **Build:** the child is in the build socket. Compare stage-entry times and child session/tool evidence across lanes to distinguish overlapping child execution from serialized activity inside Build.
- **Auto-Eval / Eval:** the child is evaluating. Staggered Eval entries after overlapping Build entries point to evaluation, model/tool, or host/repository behavior—not automatically to dispatch.
- **Blackbelt-Maintain / Maintain:** the child is checkpointing its workspace. A jj commit appearing here, or shortly after the stage transition, is expected; staggered checkpoints can reflect different work durations or serialized jj mutations while lanes remain concurrently live.

## Blackbelt checkpoints

`Blackbelt-Maintain` runs in the active scope cwd. jj has no Git-style index or staging area: the edits for that lane are already in its working-copy commit. For dirty work it describes that current `@` revision with the current item title and then opens a fresh empty working commit. Bookmark carry-forward is optional: it moves only an explicitly scope-authorized bookmark that is proven to exist, and never creates one. Consequently, an owned bookmarkless workspace from `Spawn-JJ-Workspace` checkpoints normally, while ordinary base-scope maintenance can continue carrying the bootstrap bookmark. Clean work is a no-op.

## Integration, conflicts, and cleanup

After every branch is accepted, `Integrate-JJ-Workspaces` reads the schedule-ordered opaque exports and verifies workspace ownership, the shared pinned baseline, stable ancestry, and each lane's meaningful commit stack. Before linearization, it parks each accepted lane's exact clean empty workspace revision directly on that baseline. The parked revision remains the owned workspace head for recovery, but it is detached from the lane's meaningful changes. Integration then rebases only the exact meaningful revisions: each non-empty lane follows the preceding lane in normalized schedule order, while commit order inside each lane is preserved. No-op lanes contribute no meaningful revision and no synthetic merge commit is created. When non-empty fan-in replaces a clean single-parent bootstrap boundary, integration records bounded provenance for that exact consumed boundary; it does not guess at older or incomplete provenance.

The parked workspace heads and the publishable chain are therefore separate topology. The review workspace is materialized at the final meaningful linear tip with bounded provenance for conflicts anywhere from the effective base through that tip. Schedule order makes this chain deterministic; it does not turn independently executed streams into dependency stages. A repository conflict is a bounded utility result, not an intrinsic fan-in route.

`Integration-Review` always runs. For a clean integration it spot-checks combined behavior; for a conflicted integration it resolves conflicted revisions from earliest to latest by stable change id, returns to the rewritten final tip, and verifies the complete linear range. Residual textual or semantic conflicts continue through this review path: integration never applies an automatic ours/theirs choice or discards one stream. In both cases review runs relevant checks and returns ordinary `satisfied` routing. Any cross-stream correction belongs in one final working change, which becomes a single meaningful integration-fix commit during finalization. A not-satisfied retry stays on this review socket and does not rerun accepted branches.

`Finalize-JJ-Workspace` runs only after acceptance. It resolves rewritten revisions by stable change id, verifies schedule order and the absence of conflicts across the complete publishable ancestry, and snapshots review edits. An empty review publishes its meaningful parent; a meaningful correction is retained as exactly one integration-fix commit. It advances only the original cast bookmark to that meaningful tip and keeps the normal verified empty editable `@` directly above the bookmarked meaningful tip, outside published history. If integration recorded a consumed bootstrap boundary, it removes only that exact sibling when it is unreferenced and its empty, conflict-free, single-parent shape and ancestry are still verified. Externally referenced, non-empty, merged, or otherwise non-workflow revisions are preserved. It then forgets every ownership-verified source and review workspace registration and removes each exact external directory and manifest before returning to base scope. Forgetting a source registration removes its lane-only parked workspace head; a pre-existing baseline revision protected by a bookmark is never abandoned or treated as workflow-owned cleanup. Validation precedes destructive cleanup, and partial post-publication cleanup is retryable without creating another empty base commit. Rejection or pre-publication failure intentionally preserves workspaces, exports, and revisions. Never use broad `rm -rf`; cleanup must validate producer ownership and workspace manifests.

## Monitor and inspect

The TUI/WebUI derive fork, branch-prelude, loop, and barrier visuals from the generator/consumer relationship. Their `ParallelLaneMonitorSummary` is a bounded view derived from durable cast state, not a lifecycle event stream: it may expose child artifact paths, terminal scope identity/cwd/export names, bounded terminal output, and nominal progress alongside ordered branches, attempts, counts, cancellation, and barrier progress. This operator-facing state summary should not label generic fan-in as a VCS merge or conflict. Its bounded output, scope, and progress fields do not enter parent or lane lifecycle events.

### Read the live progress view

The main TUI first shows a width-bounded coordinator row such as `Parallel slots: 2/2 running`, followed by one width-bounded line per stream in normalized schedule order. Each lane line contains an ANSI-safe progress bar, the bounded stream name, its validated active stage when it is running (or failed/interrupted), a floor percentage, and `position/total`, plus the lane status. A completed lane suppresses its retained terminal stage so `Completed` is not mistaken for ongoing work. The nominal total is the number of ordered nodes in the compiled consuming loop multiplied by the stream's assigned item count. For zero-based item cursor `i`, one-based active loop-node ordinal `j`, and loop-node count `L`, the position is `(i * L) + j`, clamped to the nominal bounds.

The branch prelude is setup rather than per-item progress, so queued lanes and lanes still in the prelude display `0/total`. Forward loop routes increase the count. A `not_satisfied` edge to an earlier node can visibly rewind the bar, while same-node retries and recovery turns leave it unchanged. Treat the percentage as nominal graph traversal, not estimated wall-clock completion.

An accepted lane displays `Completed` at `total/total` and remains visible while siblings run. A failed or interrupted lane displays `Failed` or `Interrupted` at its last valid position rather than 100%. Queued and running lanes are labeled accordingly. Lines truncate responsively instead of wrapping beyond the terminal width.

This view is an anchored `belowEditor` widget, not a floating, focus-capturing overlay and not an editor replacement. It redraws in place without stealing focus, so typing a slash command continues to work normally. The widget is removed when the barrier settles, the cast fails or is cancelled, the parent advances, or the session shuts down. Run ownership prevents delayed refreshes from restoring a stale widget.

Node-progress checkpoints are compact and emitted only when the nominal position changes. They contain bounded scalar identity and position fields—not work-item content, messages, tools, sessions, generic payloads, or cast state—and their parser rejects malformed, oversized, negative, and out-of-range records. Legitimate rewinds are accepted only from a newer guarded sequence; duplicates, same-node activity, stale attempts, and stale callbacks are ignored. Replay remains bounded.

These presentation checkpoints do not cause parent state saves and are not written to parent lifecycle events, lane `events.jsonl`, or other lifecycle artifacts. The next ordinary durable boundary may checkpoint the latest position and replay watermark. Therefore high callback volume does not bypass the same persistence, event-amplification, and replay safeguards used for high-volume fan-out.

Lane `events.jsonl` is lifecycle-only. Its allowlist is `parallel_lane_started`, `parallel_lane_resumed`, `usage_checkpoint`, `parallel_lane_terminal`, `parallel_lane_cancelled`, and `parallel_lane_budget_exceeded`. The parent lifecycle stream allowlist is `parallel_dispatch_started`, `parallel_lane_started`, `parallel_lane_resumed`, `parallel_lane_terminal`, `parallel_branches_terminal`, `parallel_branches_failed`, `parallel_cancelled`, and `parallel_budget_exceeded`, plus bounded `parallel_artifact_failure` diagnostics. Expect no generic `parallel_child_event` records and no message, reasoning, tool, session, or terminal-marker payloads.

`parallel_dispatch_started` contains parent/run/loop provenance plus only `planId`, `baseScopeId`, normalized `queueOrder`, and `maxConcurrency`. Other lifecycle records contain only stable cast/run/loop/lane/child provenance, attempt and stream/item indexes, normalized status, strictly projected scalar usage, a bounded error when needed, and—for a barrier—aggregate counts/status. Terminal output, full execution scopes, exports, accepted branch results, messages, reasoning signatures, tool arguments/results, and embedded cast state are intentionally excluded.

Inspect, in order:

1. cast state and `execution-scopes.json` for durable base, active, and branch scope identity/cwd;
2. cast-state parallel run/plan records for pinned identities, stream order, lane status, usage baseline, and replay watermark;
3. `parallel/<loop-id>/lanes/<lane-id>/attempt-<n>/lane.json` and lifecycle-only `events.jsonl` for attempt identity and status history;
4. `terminal-result.json` for the complete terminal result, `diagnostics.json` for bounded diagnostics, and `usage.json` for cumulative accounting;
5. the child paths referenced by `lane.json`: `session.jsonl` for detailed conversation/tool evidence, capped child stdout/stderr for protocol and process diagnosis, and the child artifact root for socket artifacts; and
6. utility socket artifacts for spawn, integration, review, and finalization outcomes.

Do not troubleshoot missing detail by adding child payloads to monitoring events. Use the child-owned evidence above. Replay and diagnostic arrays are bounded tails, and stdout/stderr captures are capped, so a monitoring snapshot is not a complete transcript.

On revival, do not assume the attempt number determines every child path. A resumed child can retain an earlier `sessionPath`, `runDirectory`, and `artifactRoot`; only the coordinator evidence in the current `attempt-<n>` directory is guaranteed to be current-attempt-owned.

A replacement scope's terminal exports must appear in persisted recovery state and the in-process barrier result; they are deliberately absent from lifecycle events. Seeing only the initial branch scope at fan-in indicates a terminal-scope propagation problem.

## Cancel and revive

Cancellation stops queued launches, observes available cumulative usage and a safe replay watermark, terminates running child processes, marks nonterminal branches interrupted, and retains artifacts/scopes. This durable cancellation boundary prevents usage from being counted again when retained events replay. It is safe to repeat.

Revive with:

```text
/materia revive <cast-id>
```

Parallel revival validates the original plan and graph, parent/loop/branch/child identities, child initial data, retained scope and cwd, and artifact paths. It preserves accepted branches and restarts or resumes only failed/interrupted ones. It does not replan, redistribute items, or infer missing workspace state. Identity, scope, cwd, plan, or artifact drift causes a hard integrity failure; preserve evidence and start a new cast if the original state cannot be restored.

## Troubleshooting

| Symptom | Meaning / action |
| --- | --- |
| Parallel generator rejected | Ensure `parallel: true` is accompanied by `generator: true`. |
| Schedule repair prompt | Fix duplicate/missing/out-of-range indexes or invalid stream names; no branch has started yet. |
| Ambiguous region | Ensure one unconditional generator-to-loop path, one consumer, one continuation, and no nested/overlapping region. |
| Unsafe child socket | Mark only genuinely concurrent-safe, non-interactive materia `parallelSafe: true`, or move it after the barrier. |
| Same-cwd file corruption | Scope identity did not isolate the filesystem. Add an isolation prelude or serialize the workflow. |
| Streams remain queued | The effective app/loop concurrency bound is full; queueing is deterministic. |
| Barrier skipped | At least one branch failed/interrupted. Inspect all terminal diagnostics, then revive. No subset is integrated. |
| Integration reports conflicts | Let `Integration-Review` resolve them in the integrated active scope, test, then accept for finalization. |
| Token hard stop | Child usage exhausted the parent `budget.maxTokens`; adjust deliberately with `/materia budget` and revive. |
| Revive refuses | Treat plan, graph, scope, cwd, child, or artifact mismatch as integrity drift; do not silently replan. |
| Cleanup did not run | Expected on rejection/failure. Preserve workspaces for repair or use only ownership-checked cleanup. |

Nested/overlapping parallel regions, partial fan-in, interactive children, and automatic repository integration are intentionally unsupported.
