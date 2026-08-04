# Intrinsic parallel generation and scoped execution

This document defines pi-materia's optional, workspace-neutral parallel execution contract. Parallelism is a capability of a generator, not a special utility or a VCS mode. A materia opts in with both `generator: true` and `parallel: true`; an ordinary generator remains sequential when `parallel` is omitted.

For operator procedures, see [Parallel workflow operation](parallel-workflow-operation.md). Loop control remains defined by [Loop semantics](loop-semantics.md), and utility-specific workspace behavior by [Utility Materia](utility-materia.md).

## 1. Execution scopes

Every cast executes in an explicit scope:

```ts
interface ExecutionScope {
  id: string;                         // stable identity
  cwd: string;                        // cwd for every socket in the scope
  state: Record<string, unknown>;     // scope-local, cloned for branches
  exports: Record<string, {
    producer: string;
    value: unknown;                   // opaque to parallel core
  }>;
}
```

A new cast has a persisted **base scope** rooted at the session project cwd and an **active scope**, initially a detached copy of the base. Utilities may return a validated `scopeTransition` to replace the active scope. All following agent tools and utility processes run at that scope's `cwd`. A later utility may return to base scope.

Parallel branches start from detached clones of the base scope. Cloning a scope does **not** create a directory, repository branch, worktree, or jj workspace. Different scope ids may intentionally have the same `cwd`; scope identity provides state isolation, not filesystem isolation. Scope exports are bounded, producer-owned transport values. Core persists and orders them but never interprets repository or cleanup semantics.

Base, active, and branch scope snapshots are persisted in cast state and `execution-scopes.json`. Canonical records with missing or malformed scopes are rejected. Version-1 cwd-only casts are migrated by creating a stable base scope at their persisted cwd.

## 2. Generator schedule

A parallel generator emits ordinary canonical work items and a schedule:

```json
{
  "workItems": [
    { "title": "feat: API", "context": "Implement the API" },
    { "title": "feat: UI", "context": "Implement the UI" }
  ],
  "parallelSchedule": {
    "version": 1,
    "streams": [
      { "name": "api", "workItemIndexes": [0] },
      { "name": "ui", "workItemIndexes": [1] }
    ]
  }
}
```

The runtime synthesizes the schedule instructions from `generator: true` plus `parallel: true`; reusable prompts should not hard-code them. A non-parallel generator is rejected if it emits `parallelSchedule`.

Core normalization happens on the generator socket, without a normalizer utility. It requires a supported version, unique non-empty stream names, a non-empty `workItemIndexes` array for every declared stream, in-range integer indexes, and exactly-once coverage of every work item. Stream array order and item order are preserved. Collision-safe lane ids and a plan hash are derived deterministically. Invalid output receives same-socket repair feedback before any child starts. `workItems: []` produces a deterministic empty plan and no children.

All streams execute concurrently from the same pinned baseline. Stream array order determines queueing and deterministic fan-in order, not an execution dependency in which a later stream sees an earlier stream's changes. A planner must co-locate shared contracts, dependent or order-sensitive work, and likely file/module overlap in one stream, keep cross-stream ownership narrow, and prioritize independence over balance. When that partition is unsafe, one stream is the correct schedule.

## 3. Derived graph region

A parallel generator must have one deterministic path to one consuming loop. Core derives the region rather than storing authored lane sockets:

```text
parallel generator
       |
       +-- fork --------------------------------------------------+
       |                                                          |
       +-- stream A: branch prelude once -> loop items in order --+
       +-- stream B: branch prelude once -> loop items in order --+-- barrier
                                                                  |
                                                        parent continuation
```

Sockets between the generator and consuming loop are the **branch prelude**. Each child starts at the generator successor, executes the entire prelude once, then iterates only its stream's ordered items through the selected loop. Prelude `foreach` and `advance` paths retain their own state paths; only the consuming loop is seeded with stream work items and original indexes.

The compiler preserves materia, prompts, tools, parsing, assignments, edges, retries, advancement, and scope context. Child programs have recursive parallel generation stripped. The graph must have an unambiguous generator-to-loop path and one post-barrier continuation. Conditional bypasses, nested regions, and overlapping initial regions are rejected.

Fork, prelude, loop, and barrier are derived visuals, not executable parent sockets. While children run, the parent does not traverse copied branch sockets.

## 4. Dispatch and safety

The app-level bound is workspace neutral:

```json
{ "parallelism": { "maxConcurrency": 4 } }
```

A consuming loop may only override the bound:

```json
{ "parallel": { "maxConcurrency": 2 } }
```

Both values must be positive safe integers. The loop override wins when present. Streams are queued in normalized order; excess streams start deterministically when slots open. Work inside one stream remains sequential. Parent `budget.maxTokens` is authoritative and child usage is aggregated exactly once.

Every copied child materia must explicitly declare `parallelSafe: true`. This means “trusted for concurrent child execution”; it does not mean workspace-isolated or sandboxed. Interactive and multi-turn child behavior is rejected. A trusted utility may perform its own scope-specific safety checks.

**Same-cwd warning:** without a prelude utility that changes cwd, branches can concurrently read and write the same directory. Use this only for genuinely concurrency-safe work. A scope id does not prevent file races, shared process races, or conflicting repository operations.

## 5. Intrinsic barrier and ordered fan-in

The barrier waits until every branch is terminal. Sibling branches continue after one fails so terminal diagnostics are complete, unless cancellation or a hard aggregate limit interrupts them.

If every branch is accepted, core advances the parent exactly once and emits:

- terminal outputs in normalized stream order; and
- each branch's terminal execution scope and opaque exports in that same order.

Core never shallow-merges branch state, inspects files, combines revisions, or classifies VCS conflicts. If any branch is failed or interrupted, fan-in is skipped and the cast fails. There is no partial fan-in. An empty plan advances without a utility socket.

Repository integration is an optional utility after the barrier. Thus a branch “conflict” is not a core parallel outcome: repository conflicts can only be reported by a utility that understands its own exports.

## 6. Optional jj composition

The shipped `Parallel-Experimental` loadout composes generic core behavior with jj utilities:

```text
Parallel-Plan (`generator: true`, `parallel: true`)
  -> per stream: Spawn-JJ-Workspace                 # prelude, once
  -> per item:   Build -> Auto-Eval -> Blackbelt-Maintain
  -> intrinsic ordered barrier
  -> Integrate-JJ-Workspaces
  -> Integration-Review                             # always
  -> Finalize-JJ-Workspace
  -> Narrate
```

`Spawn-JJ-Workspace` replaces the branch active scope with an owned, bookmarkless external lane workspace and opaque integration/cleanup exports while leaving the base working copy and original cast bookmark unchanged. The same utility can be placed after a regular generator and before a sequential loop to give the entire sequential path one workspace.

`Blackbelt-Maintain` uses the active scope cwd. It skips clean work; otherwise it describes the current item and opens a fresh empty commit. It optionally carries forward only an explicitly authorized bookmark that is proven to exist and never creates one, so owned bookmarkless lane workspaces checkpoint normally while ordinary base-scope maintenance may continue carrying the bootstrap bookmark. It does not rely on parallel core for checkpointing.

After the intrinsic barrier, `Integrate-JJ-Workspaces` consumes schedule-ordered scope exports and verifies ownership, one pinned baseline, and stable linear lane stacks. It first rebases each accepted lane's exact clean empty working revision directly onto the baseline. Those owned parked workspace tips remain tracked and recoverable but sit outside the publishable meaningful range. Integration then rebases only each lane's exact meaningful revisions after the previous lane's rewritten meaningful tip. It preserves intra-lane order, skips no-op lanes, and creates no synthetic merge commit. The resulting topology has a schedule-ordered meaningful chain separate from the empty lane workspace heads parked at the baseline.

The utility materializes a review workspace at the final linear tip with bounded provenance for conflicts across the complete effective-base-to-tip range. `Integration-Review` is reached for clean and conflicted outcomes: it resolves conflicted revisions earliest-to-latest by stable change id and returns to the rewritten tip, or spot-checks combined work when clean. Residual textual and semantic conflicts are review work; integration does not automatically choose ours/theirs or discard accepted stream changes. Review runs relevant checks and leaves any cross-stream correction in one final working change without publishing or cleaning.

Only after agent acceptance does `Finalize-JJ-Workspace` resolve stable change ids, verify schedule-ordered linear ancestry and reject conflicts anywhere in the publishable range. An unchanged review publishes the meaningful parent without an integration commit; a correction is retained as exactly one meaningful integration-fix commit. Finalization advances only the original cast bookmark, leaves one verified empty base working commit outside published history, and cleans every ownership-verified source and review workspace registration, exact external directory, and manifest. Source cleanup forgets the parked lane workspace heads; it never abandons a pre-existing bookmarked baseline revision. Ownership validation happens before mutation; rejection or pre-publication failure preserves scopes and revisions, while partial post-publication cleanup can be retried without creating another base commit.

## 7. Persistence, cancellation, and revival

Durable parallel state pins plan, graph, branch, child-session, attempt, and execution-scope identities. Lane states are `queued`, `running`, `accepted`, `failed`, or `interrupted`. Terminal scopes and outputs are retained in recovery state for ordered fan-in, but are not copied into monitoring events.

Parallel state is checkpointed only at durable boundaries: plan/run creation, child launch or resume, lane status transitions, a real cumulative usage delta, terminal result, cancellation, budget failure, and barrier phase changes. Message, token, tool, and other observational child callbacks may update transient progress and a replay watermark in memory, but do not save parent cast state or append generic child events. The next durable boundary checkpoints the relevant watermark. Cancellation first observes available cumulative usage and a safe watermark before aborting, so revival does not count replayed usage twice.

Cancellation is idempotent: it stops queued launches, aborts live children, drains available compact telemetry, marks nonterminal branches interrupted, and preserves the state and artifacts needed for recovery. A fresh dispatcher can cancel persisted nonterminal runs.

`/materia revive <cast-id>` does not replan. It validates immutable plan and graph identity, complete child identity, retained initial data, scope and cwd, artifact provenance, usage baselines, and replay watermarks. Accepted branches remain accepted; only failed or interrupted branches restart or resume. Attempts get distinct coordinator artifacts even when a child session retains older paths. Event-tail eviction does not change sequence generation or these recovery identities. Drift or missing scope data is an integrity failure, not a reason to guess.

## 8. Artifacts and observability

The cast manifest points to `execution-scopes.json`; durable plan/run records also live in cast state. Coordinator-owned lane evidence is attempt-local:

```text
<cast-artifact-dir>/parallel/<loop-id>/lanes/<lane-id>/attempt-<n>/
  lane.json
  events.jsonl
  terminal-result.json
  diagnostics.json
  usage.json
```

`lane.json` records the child-session paths used by that attempt (`sessionPath`, `artifactRoot`, and `runDirectory`). A newly started child normally uses paths below the same `attempt-<n>` directory, including `session.jsonl`, `run/child-launch[-attempt-n].json`, and `artifacts/`. A **resumed** child may retain session, run, and artifact paths created by an earlier attempt. The new attempt still owns only its fresh coordinator files above and references those retained child paths; it does not copy them into, or claim them as owned by, the new attempt directory.

The lane `events.jsonl` allowlist is deliberately small:

- `parallel_lane_started`
- `parallel_lane_resumed`
- `usage_checkpoint`
- `parallel_lane_terminal`
- `parallel_lane_cancelled`
- `parallel_lane_budget_exceeded`

The parent lifecycle stream allowlist is `parallel_dispatch_started`, `parallel_lane_started`, `parallel_lane_resumed`, `parallel_lane_terminal`, `parallel_branches_terminal`, `parallel_branches_failed`, `parallel_cancelled`, and `parallel_budget_exceeded` (plus bounded `parallel_artifact_failure` diagnostics). There is no `parallel_child_event` stream. Raw `message_update`, `tool_execution_update`, `entry_appended`, message, turn, tool, session, reasoning, tool argument/result, and terminal-marker payloads are not lifecycle events.

Lifecycle payloads are compact. `parallel_dispatch_started` contains parent/run/loop provenance plus only `planId`, `baseScopeId`, normalized `queueOrder`, and `maxConcurrency`. Lane records contain stable provenance (`parentCastId`, `runId`, `loopId`, `laneId`, `childCastId`, attempt and stream/item indexes), status, strictly projected scalar usage when applicable, and a bounded error. Barrier records contain run provenance, status, and aggregate lane counts/status summaries. They never contain terminal output, message data, reasoning signatures, tool arguments/results, full execution scopes, export values, accepted branch results, or embedded cast state. This lifecycle-stream contract is not a transcript or fan-in transport. Child token and cost usage is cumulative, monotonic, and counted once in parent totals.

Do not confuse lifecycle streams with `ParallelLaneMonitorSummary`, the bounded TUI/WebUI DTO derived from durable cast state. That state-derived summary currently includes child artifact paths, terminal scope identity/cwd/export names, and a bounded rendering of terminal output to help operators locate and inspect a lane. It is not appended to parent or lane event streams and does not weaken the lifecycle payload allowlist.

Detailed evidence belongs in artifacts rather than parent or lane monitoring streams:

- the child `session.jsonl` is the canonical Pi conversation/tool history;
- `terminal-result.json` holds the complete child terminal result used by the coordinator;
- `diagnostics.json` and `usage.json` hold attempt diagnostics and cumulative accounting;
- child stdout/stderr files referenced by `lane.json` are capped captures for launch/protocol diagnosis; and
- child socket artifacts under the referenced child artifact root hold socket-level evidence.

Runner replay events and diagnostics are bounded tails, and stdout/stderr capture stops growing at configured byte limits. A terminal marker is consumed exactly once through the terminal channel; it is not retained in replay telemetry. A clean process close without an explicit accepted terminal result cannot make a lane eligible for fan-in.

### Liveness and terminal resource retirement

Eventing heartbeat is global to the active parent cast. When eventing and a positive heartbeat interval are configured, one `lifecycle.heartbeat` continues while the parent waits at the parallel barrier and stops when the cast becomes terminal; parallel lanes do not create one heartbeat per child or project token traffic as liveness. See [Runtime Eventing](runtime-eventing.md#73-heartbeat).

A terminal marker establishes the child result, while process close remains the resource-liveness boundary. Before retirement, the runner awaits close as necessary so parsers and capped stdout/stderr writes are flushed. Once terminal artifacts and durable lane state are secured, the coordinator unsubscribes observers and releases process listeners, parsers, captures, replay tails, usage maps, prepared graphs, terminal queues, and parent-context references. Accepted child records are discarded after barrier settlement. Failed/interrupted attempts retain only the minimal identity, scope, path, usage, and watermark data required for supported resume. Generation checks prevent late callbacks from a retired run from mutating a later run that reuses the dispatcher.

See [Graph semantics](graph-semantics.md), [Utility Materia](utility-materia.md), [Workflow safety](workflow-safety.md), and [Resilient Inference and Revival](resilient-inference-and-revival.md).
