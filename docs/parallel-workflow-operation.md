# Experimental parallel workflow operation

This is the operator and authoring guide for pi-materia's experimental parallel
workflow mode. Read [Parallel loop orchestration semantics](parallel-loop-orchestration.md)
for the normative runtime contract; this guide explains how to configure, run,
observe, recover, and clean up a run.

> **Experimental:** parallel mode is opt-in, jj-only, and intentionally
> conservative. Test it on a disposable branch/repository before using it for
> important work. Existing loadouts remain sequential unless a loop explicitly
> has `parallel` metadata.

## Before enabling it

Parallel mode requires:

- `jj` on `PATH` and a jj repository for the project;
- a parent working copy that can be pinned as an immutable baseline;
- a planner that emits canonical `workItems` and a valid version-1
  `parallelSchedule` sidecar;
- a loop whose complete child subgraph is safe for isolated execution; and
- a bounded `maxConcurrency` and a parent token budget large enough for the
  aggregate child work.

The shipped `Parallel-Experimental` loadout satisfies these requirements for a
small Build → Eval → lane-checkpoint loop. It is locked and is **not** the
active default. Select it explicitly:

```text
/materia loadout Parallel-Experimental
/materia grid
/materia cast "implement the requested changes"
```

The loadout runs bootstrap, parallel planning, deterministic stream
normalization, child lanes, jj fan-in, conflict resolution, integration
assessment, finalization, and narration. It uses `maxConcurrency: 2` as a
conservative default. Use a normal loadout when jj is unavailable or when the
work cannot be isolated safely.

## Authoring planner streams

The planner owns the canonical work-item list. Each item has only `title` and
`context`; stream metadata belongs in the sidecar and must not be copied into
items:

```json
{
  "workItems": [
    { "title": "feat: API", "context": "Implement the API" },
    { "title": "feat: UI", "context": "Implement the UI" },
    { "title": "test: integration", "context": "Add integration coverage" },
    { "title": "docs: API usage", "context": "Document the API" }
  ],
  "parallelSchedule": {
    "version": 1,
    "streams": [
      { "name": "api", "workItemIndexes": [0, 2] },
      { "name": "ui", "workItemIndexes": [1, 3] }
    ]
  }
}
```

A stream is ordered. One stream becomes one persistent lane and its items run
sequentially in the listed order. The stream array is also the deterministic
fan-in order; completion time does not change it.

Planner rules:

- use `version: 1`;
- give every stream a unique, non-empty `name`;
- give every non-empty stream at least one index;
- assign every work-item index exactly once, with no duplicates or omissions;
- keep dependent items in the same stream and place independent work in
  separate streams;
- prefer a small number of balanced streams over one stream per item; and
- do not invent lane ids or mutate the canonical item objects.

The deterministic `Normalize-Parallel-Streams` utility validates these rules
before a workspace or child process is created. It preserves `workItems` and
writes `state.parallelPlan`, including stable lane ids such as `lane-api` and
`lane-ui`. A malformed schedule fails with corrective planner feedback; it
never starts a partially scheduled run. An empty `workItems` list is a valid
no-op only when its schedule has no streams.

### Authoring the loop region

A parallel loop is an existing loop with an explicit opt-in block. Its input
must be the normalized plan, not the raw planner sidecar:

```json
{
  "loops": {
    "parallelWork": {
      "consumes": { "from": "Socket-5", "output": "workItems" },
      "sockets": ["Socket-6", "Socket-7", "Socket-8"],
      "parallel": {
        "planInput": "state.parallelPlan",
        "maxConcurrency": 2,
        "workspaceMode": "jj",
        "failurePolicy": "all_terminal",
        "fanIn": "ordered"
      },
      "exits": [
        {
          "id": "parallel-clean-fan-in",
          "from": "Socket-8",
          "condition": "satisfied",
          "targetSocketId": "Socket-9"
        },
        {
          "id": "parallel-conflict-resolver",
          "from": "Socket-8",
          "condition": "not_satisfied",
          "targetSocketId": "Socket-10"
        }
      ]
    }
  }
}
```

`workspaceMode`, `failurePolicy`, and `fanIn` are currently closed MVP values:
`jj`, `all_terminal`, and `ordered`. Omit `parallel` entirely to retain the
ordinary sequential loop.

In the WebUI, duplicate the locked experimental loadout or author a project
loadout, enable Parallel on the loop region, choose the normalized plan input,
and set the concurrency and fan-in fields. Add clean and conflict exits as
loop-owned routes. Save only after graph validation reports no errors. Do not
create lane sockets or ordinary parent edges for lanes; the editor derives the
fork, barrier, and fan-in visuals from the region metadata.

## Choosing a safe child subgraph

The loop's `sockets` list is the complete child program. Every referenced
materia must explicitly declare `parallelSafe: true`, and graph validation also
rejects known unsafe operations. Treat this as a trusted capability declaration,
not as a security sandbox: a custom command marked safe can still affect shared
external systems.

Use this checklist before enabling a region:

- The child has deterministic entry and terminal boundaries.
- Build, evaluation, retry edges, item advancement, and checkpointing are all
  inside the selected subgraph.
- Every child materia is workspace-local and marked `parallelSafe: true`.
- No child step is multi-turn or asks the user for input.
- No child step advances the parent bookmark, publishes externally, performs
  parent integration, or otherwise relies on shared mutable state.
- No parallel region is nested inside or overlaps this region.
- Parent routes do not target or traverse hypothetical lane sockets.

The shipped experimental flow separates responsibilities like this:

```text
Parent:  Blackbelt-Bootstrap -> Parallel-Plan -> Normalize-Parallel-Streams

Child:   Build -> Auto-Eval -> Parallel-Lane-Checkpoint  (repeat per item)

Parent:  clean fan-in -> Parallel-Integration-Eval -> Parallel-Finalize
         conflict fan-in -> Parallel-Resolver -> Parallel-Integration-Eval
```

`Build`, `Auto-Eval`, and `Parallel-Lane-Checkpoint` are explicitly child-safe.
Bootstrap, bookmark maintenance, finalization, integration, and the resolver
remain parent operations. A child receives its stream's items and bounded cast
context, not the mutable state of sibling lanes.

## How the graph represents a run

The graph remains symbolic; it does not expand into runtime lane sockets:

```text
                         +------------------+
  planner/normalizer --->| parallel fork    |--- lane A: child loop ---+
                         |                  |--- lane B: child loop ---+-- barrier
                         +------------------+                          |
                                                                        v
                                                        clean/satisfied join
                                                                        |
                                                        integration eval
                                                                        |
                         conflict/not_satisfied ------> resolver agent
```

Interpret the symbols as follows:

- **Fork:** the parent has accepted a normalized plan and is dispatching
  ordered streams. It does not mean that every lane has started; concurrency
  may leave streams queued.
- **Child loop:** each lane runs the complete selected subgraph in its own
  persistent jj workspace. Work inside a lane is still sequential.
- **Barrier:** the parent waits until every lane is terminal. A failed or
  interrupted lane prevents fan-in; healthy lanes are not silently discarded.
- **Clean/satisfied join:** all lanes were accepted and jj created a clean
  integration. The parent follows the satisfied route to integration
  evaluation.
- **Conflict/not_satisfied route:** all lanes were accepted, but jj reported a
  conflict during fan-in. The parent resolver repairs the integration revision;
  it does not rerun lanes.

Lane failure, cancellation, invalid configuration, missing jj, or workspace
loss is a cast failure, not an ordinary per-item `not_satisfied` result. The
not-satisfied symbolic route is reserved for the structural fan-in conflict
outcome (and the configured resolver/evaluator behavior).

## A complete example

This example uses the shipped flow with two streams and four items.

1. Select and inspect the experimental loadout:

   ```text
   /materia loadout Parallel-Experimental
   /materia grid
   ```

   Confirm that planning is followed by normalization, that
   `parallelWork.parallel.planInput` is `state.parallelPlan`, and that the
   child sockets are Build, Eval, and lane checkpointing.

2. The planner returns the canonical list and sidecar shown below:

   ```json
   {
     "workItems": [
       { "title": "feat: API", "context": "Implement the API" },
       { "title": "feat: UI", "context": "Implement the UI" },
       { "title": "test: integration", "context": "Add integration coverage" },
       { "title": "docs: API usage", "context": "Document the API" }
     ],
     "parallelSchedule": {
       "version": 1,
       "streams": [
         { "name": "api", "workItemIndexes": [0, 2] },
         { "name": "ui", "workItemIndexes": [1, 3] }
       ]
     }
   }
   ```

3. Normalization preserves the items and records a plan conceptually like:

   ```json
   {
     "version": 1,
     "planId": "parallel-plan-v1-<stable-hash>",
     "workItemCount": 4,
     "streams": [
       { "laneId": "lane-api", "name": "api", "streamIndex": 0, "workItemIndexes": [0, 2] },
       { "laneId": "lane-ui", "name": "ui", "streamIndex": 1, "workItemIndexes": [1, 3] }
     ]
   }
   ```

4. The coordinator pins one parent baseline and creates `lane-api` and
   `lane-ui` workspaces. With `maxConcurrency: 2`, both lanes can run. Each
   lane executes Build → Eval → checkpoint for its first item, then repeats for
   its second item. A no-op item does not create an empty jj checkpoint.

5. If both children finish accepted, the parent verifies their heads and fans
   them in in `api`, then `ui` order. A clean result goes to
   `Parallel-Integration-Eval` and then `Parallel-Finalize`, which advances the
   bootstrap-owned bookmark, creates a fresh empty parent working commit, and
   removes the owned lane workspaces.

6. If the heads conflict, the parent records the conflicted paths in fan-in
   artifacts and follows the resolver route. After the resolver repairs the
   integration, the integration evaluator must accept it before finalization.

7. If `lane-ui` fails, `lane-api` may finish and remains retained, but no
   partial fan-in occurs. After correcting the cause, `/materia revive <cast-id>`
   validates the original plan, baseline, accepted head, and workspace
   ownership, then reruns only the failed or interrupted lane.

## Observing parent and lane artifacts

The Pi/TUI status widget shows a compact aggregate such as:

```text
parallel parallelWork q0 r1 a1 f0 i0 fi0 c0 ✓1/2
```

The fields are queued, running, accepted, failed, interrupted, fan-in,
conflict, and terminal/completed counts. `/materia status` and `/materia ui`
show the current parent phase. The WebUI's parallel region details connect each
lane id to its child session, artifact paths, jj workspace path, stream order,
and work-item indexes. The graph itself remains symbolic.

The parent cast artifact directory is normally `.pi/pi-materia/<cast-id>/`.
The stable parallel portion is:

```text
parallel/<loop-id>/
  fan-in.json                         # after fan-in starts
  lanes/<lane-id>/attempt-1/
    lane.json                         # identity and workspace ownership
    events.jsonl                      # provenance-enriched child events
    terminal-result.json
    revision.json                     # observed/accepted jj revision
    diagnostics.json
    usage.json
    session.jsonl
    run/child-launch.json             # secret-free launch specification
    artifacts/child-stdout.jsonl
    artifacts/child-stderr.log
    artifacts/<socket artifacts>      # child socket outputs
```

A revived attempt uses the same lane identity and an incremented attempt
location. The parent cast's `manifest.json`, `events.jsonl`, and `usage.json`
remain the source for coordinator lifecycle, aggregate telemetry, and budget
accounting. Paths and filenames may gain adapter-specific files, but lane
identity, attempt, workspace ownership, and provenance are stable. Launch
specifications and diagnostics never contain credentials.

When debugging, inspect in this order:

1. the parent status/manifest for `runId`, `planId`, phase, and aggregate
   failure reason;
2. the lane `lane.json` for stream membership, child id, workspace, and attempt;
3. `terminal-result.json`, `revision.json`, and `diagnostics.json`;
4. `events.jsonl`, `child-stderr.log`, and the child socket artifacts; and
5. `fan-in.json` for ordered heads, integration revision, conflict paths, and
   resolver/finalization provenance.

Do not treat a child process exit or a populated stdout file as acceptance. A
lane is accepted only when its terminal result and verifiable jj head satisfy
the coordinator contract.

## Cancellation, conflicts, and recovery

### Cancel a run

Use the normal parent command:

```text
/materia abort
```

Session shutdown invokes the same coordinator cancellation path. Cancellation
stops queued launches, terminates live child process trees, flushes available
telemetry, marks nonterminal lanes `interrupted`, and preserves workspaces,
heads, and artifacts. It is idempotent; late child events cannot reopen a lane
or start fan-in. Do not delete the preserved workspaces merely because the
parent is no longer active.

### Resolve a fan-in conflict

A resolver is invoked only after **every** lane is accepted and jj materializes
a conflicted integration revision. Review the paths and bounded details in
`fan-in.json` and the monitor, then let the configured parent resolver repair
that integration revision. The resolver must not:

- rerun a child lane;
- change the normalized plan or stream order;
- rewrite accepted lane heads; or
- advance the bookmark or publish externally.

A clean fan-in bypasses the resolver. Resolver retries and post-resolution
checks use the explicit graph traversal budgets. If resolver or integration
evaluation fails, the conflicted integration and lane workspaces remain
available for repair; finalization does not advance shared repository state.

### Revive failed or interrupted lanes

List casts if the id is not known, then revive the parent cast:

```text
/materia casts
/materia revive <cast-id>
```

Revival is not replanning. It validates the original plan/config identity,
immutable baseline, accepted lane heads, child session metadata, and ownership
manifests. It retains accepted lanes and restarts only failed or interrupted
lanes with the same lane ids, stream membership, and order. It does not
redistribute items or automatically replace the planner schedule.

A completed child with `accepted: false` is still an unaccepted lane and may be
revived. If a successful head has drifted, a workspace is missing, or a
manifest belongs to another run, revival hard-fails rather than guessing. Copy
or inspect the artifacts, repair ownership/repository state, or start a new
plan; never force a new baseline into an existing run.

### Clean preserved workspaces

Successful finalization cleans owned workspaces automatically, and this is the
preferred path. Failed, interrupted, conflict-preserved, and evaluator-rejected
runs intentionally keep them for diagnosis and revival.

Before discarding a preserved run:

1. save the parent and lane artifacts needed for diagnosis;
2. inspect each lane's `workspaceName`, `workspacePath`, `workspaceRoot`,
   `manifestPath`, parent cast id, loop id, lane id, and baseline;
3. verify that the manifest is a jj manifest owned by this exact run and that
   the path is inside its external runtime-owned workspace root;
4. use the jj workspace backend's ownership-checked cleanup operation, which
   forgets the workspace before removing the owned directory and manifest; and
5. confirm that the parent working copy, parent bookmark, other lane paths, and
   the artifact directory were not changed.

The current MVP has no general-purpose `parallel clean` CLI command. Do not
use a broad `rm -rf` against `/tmp`, the repository, or the workspace root, and
do not manually remove a tracked workspace without first forgetting it. If an
ownership manifest is missing or mismatched, stop and preserve the directory
for diagnosis rather than bypassing the checks.

## Troubleshooting

| Symptom | Likely cause | Action |
| --- | --- | --- |
| `jj` unavailable or the loadout fails before fan-out | Parallel mode has no Git/worktree fallback. | Install `jj`, ensure it is on `PATH`, and run the jj bootstrap path in a repository. Otherwise use a sequential loadout. |
| Plan rejected before any child starts | Unsupported version, duplicate/missing index, empty stream, duplicate stream name, or sidecar from an ordinary generator. | Fix the planner output; keep canonical items unchanged. Re-run planning/normalization rather than creating lanes manually. |
| Graph validation reports an unsafe socket | A child materia lacks `parallelSafe: true`, is interactive, or performs known shared-state work. | Move the operation outside the child region or replace it with a workspace-local child-safe step. The flag is not a sandbox. |
| A lane is queued longer than expected | `maxConcurrency` is a bound, not a start-all promise. | Inspect aggregate status and wait for a slot; lower stream count or raise concurrency only after reviewing CPU, token, and repository limits. |
| Parent working copy changed during fan-out | This violates the parent-workspace invariant or a custom child command touched shared state. | Stop and preserve artifacts. Do not fan in or clean up; inspect the offending materia and repository revisions. |
| Child failed but siblings are still running | All-terminal failure policy lets healthy siblings finish for diagnostics. | Wait for terminal lanes, inspect the failed lane's diagnostics/stderr/revision, then revive only failed/interrupted lanes. No partial fan-in is performed. |
| Workspace is stale, missing, untracked, or has a different revision | External deletion, manual jj mutation, path drift, or a changed baseline. | Do not recreate it under the old identity. Inspect the manifest and accepted head; repair or preserve it, then use revive. Recovery rejects integrity drift. |
| `fan-in.json` reports conflicts | Accepted lane heads overlap in jj. | Review conflicted paths, let the configured parent resolver repair the integration, then require integration evaluation. Do not rerun successful lanes. |
| Resolver/evaluator failed after fan-in | The integration is preserved for repair and finalization has not advanced the bookmark. | Inspect the integration and resolver artifacts, use configured retry budgets, and keep lane workspaces until accepted or deliberately cleaned. |
| Run stopped at the token limit | `budget.maxTokens` is an aggregate parent hard stop. | Inspect `/materia budget`, raise the cast-local limit to a safe value if appropriate, then revive the preserved run. Parallelism never raises the limit automatically. |
| `/materia revive` refuses to continue | Plan/config/baseline/head/session/manifest validation failed. | Treat it as an integrity failure. Preserve artifacts, correct the repository or ownership issue, or start a new run; do not silently replan. |

## MVP non-goals and limits

The current experimental mode deliberately does **not** provide:

- Git worktrees or a Git fallback; only jj workspaces are supported;
- nested or overlapping parallel regions;
- partial fan-in or merging a subset of successful lanes;
- automatic replanning, stream redistribution, or changing the plan during
  revival;
- parent traversal through materialized lane sockets;
- live user interaction or multi-turn child materia;
- shared parent bookmark advancement, publishing, or integration from a child;
- unlimited concurrency, automatic budget expansion, or hidden child usage;
- cleanup of unowned, ambiguous, missing-manifest, or arbitrary directories; or
- a promise that all lanes start simultaneously or that completion order affects
  fan-in order.

For the complete invariants, state transitions, persistence contract, and
implementation-level edge semantics, return to [Parallel loop orchestration
semantics](parallel-loop-orchestration.md).
