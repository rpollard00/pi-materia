# Parallel loop orchestration semantics (experimental)

This document is the authoritative contract for the opt-in parallel mode of an
existing loop region. Parallel mode is deliberately narrower than general
workflow concurrency: it is **jj-only**, runs one persistent child process per
planner-defined stream, and keeps the parent cast as a coordinator. A loadout
that does not opt in has the ordinary sequential loop semantics described in
[Loop semantics](loop-semantics.md).

The feature is experimental. Its durable state, artifacts, and workspace
manifests are part of the recovery contract, but the MVP does not promise
Git worktrees, nested parallel regions, partial fan-in, or automatic
replanning.

## 1. Terms and invariants

- A **planner** produces the canonical `workItems` list and, when explicitly
  enabled for parallel planning, a `parallelSchedule` sidecar.
- A **stream** is an ordered list of indexes into that canonical list. One
  stream maps to one **lane**.
- A **lane** is one persistent child cast running in one jj workspace. It
  processes every item in its stream through the complete selected loop
  subgraph, in stream order.
- The **parent** is the original cast. In parallel mode it coordinates lanes,
  aggregates their events and usage, and performs fan-in; it never traverses
  the member sockets as ordinary parent sockets.
- **Fan-in** is the deterministic jj integration of accepted lane heads.
- **Acceptance** means that a lane's child cast reached its local terminal
  success state and recorded a verifiable lane head. A completed subprocess
  without an accepted result is not accepted.

The following invariants are normative:

1. Parallel mode is opt-in. Omitting its loop metadata preserves sequential
   loop serialization and runtime behavior exactly.
2. The planner's stream order is stable input to dispatch, lane identity,
   checkpointing, fan-in ordering, and recovery. The runtime does not
   redistribute items between streams.
3. Every lane reaches a durable terminal state before the run is decided:
   `accepted`, `failed`, or `interrupted`. A lane failure does not silently
   become a successful empty lane.
4. No lane is fanned in unless every lane is accepted. There is no partial
   fan-in.
5. The parent workspace, parent working-copy revision, and bootstrap-owned
   bookmark are untouched during planning, workspace creation, child
   execution, and lane checkpointing. They may be changed only at the
   explicit successful fan-in/finalization boundary.
6. A parallel region cannot contain or overlap another parallel region. A
   compiled child loadout is always sequential and has parallel metadata
   removed.
7. A failed or interrupted run retains successful heads, lane workspaces, and
   diagnostics for explicit revival; it does not replan automatically.

## 2. Planner sidecar and ordered streams

The planner sidecar is an extension of the normal generator handoff, not a
replacement for it. Canonical work items remain objects with only the normal
`title` and `context` fields. Streams refer to indexes rather than copying or
mutating those objects.

A version-1 planner result is conceptually:

```json
{
  "workItems": [
    { "title": "feat: API", "context": "Implement the API" },
    { "title": "feat: UI", "context": "Implement the UI" },
    { "title": "test: integration", "context": "Add integration coverage" }
  ],
  "parallelSchedule": {
    "version": 1,
    "streams": [
      { "name": "api", "workItemIndexes": [0, 2] },
      { "name": "ui", "workItemIndexes": [1] }
    ]
  }
}
```

The exact persisted DTO may include provenance, but its semantics are fixed:

- `parallelSchedule` is accepted only from a materia/socket explicitly
  declared as the parallel planner for the selected region. An ordinary
  generator cannot opt into scheduling by emitting the field.
- `version` is required and is rejected when unsupported.
- Stream names are non-empty and unique within the schedule. Their array order
  is the canonical stream order; it is not sorted by completion time or name.
- Every work-item index is an integer in range and occurs exactly once. An
  item cannot be dropped, duplicated, or assigned to two streams.
- A stream is non-empty. An empty `workItems` list is a valid deterministic
  no-op plan and produces no lanes.
- Schedule validation is performed before any child workspace or subprocess
  is created. Correctable planner errors return actionable planner feedback;
  they do not create a partially scheduled run.
- The sidecar is consumed by the deterministic normalizer and is not copied
  into generic downstream agent context. The normalizer preserves the
  canonical `workItems` array and emits a normalized `state.parallelPlan`
  containing stable lane identities, ordered stream membership, and the plan
  identity used for recovery.

The normalized plan is immutable for a run. Changing item order, stream
membership, configuration, or the source planner result creates a new plan
identity and requires a new run rather than an in-place revival.

## 3. Symbolic graph semantics

A parallel loop is represented as one symbolic region, not as a set of
materialized lane sockets. The graph editor and runtime expose the same
conceptual shape:

```text
                         +------------------+
  planner/normalizer --->| parallel fork    |--- lane A: child loop ---+
                         |                  |--- lane B: child loop ---+-- barrier
                         |                  |--- lane C: child loop ---+
                         +------------------+                           |
                                                                        v
                                                        clean/satisfied join
                                                                        |
                                                        post-integration eval
                                                                        |
                         conflict/not_satisfied ------> resolver agent
```

The fork and barrier are derived visual/control markers owned by the loop
region. They are not executable sockets, do not receive individual lane
edges, and must not be addressed by parent routes. The parent enters the
region once, starts or resumes the coordinator, waits for the barrier, and
then follows the loop's symbolic post-integration routes:

- a clean fan-in follows the satisfied route and bypasses resolution;
- a conflicted fan-in follows the `not_satisfied` conflict route to the
  configured resolver in the parent session;
- lane failure, cancellation, invalidation, or missing infrastructure is a
  cast failure, not a normal per-item `not_satisfied` result.

The resolver route is therefore distinct from a child evaluator rejecting a
work item. Child retries stay inside the child subgraph. Resolver retries use
an explicit traversal budget and never rerun successful lanes.

## 4. Child execution model

When the parent enters an enabled region, the coordinator:

1. validates the normalized plan, loop topology, child-safe capabilities, jj
   availability, and concurrency configuration;
2. pins the immutable parent baseline revision;
3. creates one owned jj workspace and one persistent child session for each
   stream, subject to `maxConcurrency`;
4. compiles the selected loop's complete socket subgraph into an ephemeral
   child loadout for that stream; and
5. runs the child to local completion while the parent waits as coordinator.

The child loadout preserves the selected sockets' materia, prompts, models,
tools, parsing and assignment rules, normal edges, retry budgets, iterator
semantics, and per-item advancement. It is seeded only with that lane's
ordered work items. Child exits are rewritten to terminate locally, and
parallel metadata is removed so a child cannot recursively schedule another
parallel region.

A child receives the original request plus bounded cross-cutting plan context
needed to understand the cast. It does not receive unrelated lane state and
cannot write generic mutable parent state. Child socket events and outputs are
forwarded to the parent as provenance-enriched telemetry, not as parent graph
traversals.

Within a lane, work remains sequential:

```text
item 1: enter loop subgraph -> retry/advance -> checkpoint
item 2: enter loop subgraph -> retry/advance -> checkpoint
item 3: enter loop subgraph -> retry/advance -> checkpoint
```

The existing per-item `satisfied`/`not_satisfied`, `advance`, explicit retry
edges, and no-advance protection continue to apply inside the child. A lane
is accepted only after all of its items complete and its local terminal result
is accepted. The parent does not treat a child process exit alone as success.

## 5. Durable run and lane states

The coordinator persists a run record keyed by the parent cast and loop
identity. It records the plan/config identity, baseline revision, stream
order, concurrency, fan-in policy, current phase, aggregate usage, and
provenance for every transition. Lane records are keyed by normalized lane
identity and retain the stream indexes, workspace ownership, child session,
attempt, timestamps, accepted head, diagnostics, and last observed event.

Lane states are monotonic within an attempt:

| State | Meaning |
| --- | --- |
| `queued` | Validated stream waiting for a concurrency slot. No child has started. |
| `running` | Its owned workspace and child session are active. |
| `accepted` | The child reached local success and its lane head was verified. |
| `failed` | The child or lane infrastructure reached a terminal failure. |
| `interrupted` | Cancellation, parent shutdown, or a hard budget stop prevented completion. |

The coordinator phase is separate from lane state and may be `dispatching`,
`awaiting_lanes`, `fan_in`, `conflict`, `resolving`, `evaluating`, `completed`,
or `failed`. `fan_in` and `conflict` are run phases, not new lane outcomes.
Persisted callbacks include the run and attempt identity; stale child events
cannot regress a terminal lane or update a newer cast run.

## 6. All-terminal failure policy

Ordinary child failure is isolated to that lane while sibling lanes continue.
The scheduler continues queued streams and lets already-running siblings
finish, subject to cancellation and the parent token budget. Once all lanes
are terminal:

- if every lane is `accepted`, fan-in may begin;
- if any lane is `failed` or `interrupted`, fan-in is skipped and the parent
  fails with bounded aggregate diagnostics;
- accepted lane heads remain recorded and are not discarded;
- the failed parent is revivable only through the explicit recovery contract
  below.

This policy intentionally avoids producing a misleading repository state from
a subset of the plan. It also means that a fast failure does not immediately
kill useful sibling diagnostics. Parent cancellation is different: it stops
queued launches, interrupts live lanes, and preserves the resulting state.

An empty normalized plan is deterministic: the coordinator records a completed
no-lane run, performs no jj fan-in, and follows the region's ordinary empty
plan completion route without changing the parent workspace.

## 7. jj workspace and checkpoint lifecycle

Parallel mode requires `jj` and a jj repository. There is no Git worktree or
Git fallback in this MVP.

### Fan-out

Before fan-out, bootstrap must have established the repository precondition
and a verified parent working commit. The coordinator records one immutable
baseline revision for the entire run. Each lane is created from that baseline
under an external, runtime-owned workspace root. A lane workspace name, path,
operation id, baseline, and ownership token are written to its manifest.

Workspace creation is idempotent for the same parent run, loop, lane, plan,
and baseline. A path or manifest belonging to another run is never reused.
The parent working copy and parent bookmark are not checked out, reset, moved,
or described while lanes are being created or executed.

### Lane-local checkpoints

Checkpointing is lane-local. After a meaningful item changes the lane:

1. inspect the lane workspace with jj;
2. skip the checkpoint when there is no change;
3. describe the meaningful revision with the current item title;
4. record that revision as the latest meaningful lane head; and
5. open a fresh empty working commit for the next stream item.

A no-op item does not manufacture an empty checkpoint. A checkpoint utility
must never advance the parent bookmark, parent working copy, or another
lane's reference. If a lane fails after a checkpoint, that head remains
available for diagnosis and revival but is not eligible for fan-in until the
lane reaches accepted terminal state.

### Successful cleanup

After successful fan-in and post-integration evaluation, finalization verifies
the integration revision, describes it deterministically, advances the
bootstrap-owned parent bookmark, and creates/verifies a fresh empty parent
working commit. Only then may the coordinator forget jj workspaces and delete
owned workspace directories. Cleanup is ownership-checked and cannot follow
traversal or symlink escapes.

Failed, interrupted, conflicted, or evaluator-rejected runs preserve lane
workspaces and revision heads. Cleanup is an explicit operator/recovery action,
not an implicit failure handler.

## 8. Fan-in, conflicts, and resolution

Fan-in is legal only after every lane is accepted. The coordinator snapshots
and verifies each recorded lane head, rejects missing or drifted heads, and
orders heads by normalized stream order. It then materializes one parent
integration revision with those lane heads as its parents.

Fan-in has two structural outcomes:

- **Clean integration:** no jj conflicts exist. The run records the ordered
  heads and follows the loop's satisfied join to the post-integration
  evaluator. The resolver is not invoked.
- **Conflict:** jj materializes a conflicted integration revision. The run
  records conflicted paths and bounded conflict details, exposes an aggregate
  `not_satisfied` result, and follows the symbolic conflict route to the
  configured resolver agent in the parent session.

A resolver repairs the integration revision; it does not modify lane heads or
rerun child streams. Resolver attempts are bounded by explicit graph retry
budgets. After resolution, the post-integration evaluator must verify that
conflicts are gone and that the integrated result is acceptable. Evaluator or
resolver failure preserves the integration revision, lane workspaces, and
artifacts for repair. Only an accepted clean or resolved integration may reach
bookmark advancement and workspace cleanup.

The parent workspace invariant is especially important here: no parent
working-copy or bookmark mutation occurs before this successful-lanes fan-in
boundary. During fan-in, the coordinator may create an integration revision in
the parent jj repository, but it must not publish or discard the prior parent
state. Finalization is the only step that advances shared repository state.

## 9. Revival and cancellation

### Revival

`/materia revive` may resume a run that has failed or has interrupted lanes.
Before doing so it validates:

- the original normalized plan and parallel configuration identity;
- the original immutable baseline;
- every successful lane head and its stream membership;
- child session/run metadata; and
- ownership and integrity of each preserved workspace.

Revival resumes or restarts only failed and interrupted lanes. It never reruns
accepted lanes, redistributes streams, changes concurrency into a new plan, or
asks the planner to produce a replacement schedule. New attempts retain the
same lane identities and stream order. When all revived lanes are accepted,
fan-in is attempted over the complete set of accepted heads, including the
unchanged heads from the first attempt.

If a baseline, plan, successful head, or ownership manifest cannot be
validated, revival hard-fails with a diagnostic rather than guessing or
silently rebuilding the repository state.

### Cancellation

Parent abort, session shutdown, and cast cancellation use one idempotent
coordinator operation:

1. stop launching queued lanes;
2. terminate every live child process and its process group;
3. flush available child events and diagnostics;
4. mark every nonterminal lane `interrupted`; and
5. persist all workspaces, heads, and artifacts for diagnosis or revival.

Repeated cancellation is a no-op after the first durable transition. Late
child callbacks may add bounded telemetry but cannot turn an interrupted run
into a successful one or start fan-in.

## 10. Artifact and ownership contract

The parent artifact directory is the durable source of truth for orchestration.
A canonical layout is:

```text
<cast-artifact-dir>/parallel/<loop-id>/
  run.json
  plan.json
  lanes/<lane-id>/
    manifest.json
    attempts/<attempt>/launch.json
    attempts/<attempt>/events.jsonl
    attempts/<attempt>/stdout.log
    attempts/<attempt>/stderr.log
    attempts/<attempt>/sockets/...
  fan-in.json
  resolver/...
```

Implementations may add files, but they must retain stable parent-cast,
loop, and lane identities. Lane artifacts include the launch specification
(with secrets removed), child session identity, streamed events, socket
outputs, normalized terminal result, usage, jj workspace manifest, revision
heads, and bounded failure diagnostics. Fan-in artifacts include the ordered
head list, integration revision, conflict details, resolver attempts, and
finalization result.

The runtime owns only workspaces named in a valid manifest for the current
cast, loop, lane, plan, and baseline. It may forget/delete those directories
only after successful finalization or an explicit operator cleanup. It must
not delete arbitrary paths, another run's workspace, or retained artifacts.
Environment credentials and secret values are never written to launch specs,
events, diagnostics, or artifacts.

Child events preserve child ordering and are enriched with parent cast id,
loop id, lane id, stream order, work-item index, and attempt. Child token and
cost usage is aggregated once into the parent totals and remains subject to
the parent operator-controlled budget; parallelism never silently raises that
budget or double-counts forwarded events.

## 11. Child safety and workflow limits

A parallel child subgraph is a trusted, workspace-local capability boundary,
not a sandbox. The graph validator must reject known unsafe or interactive
materia, including multi-turn/user-interactive steps and operations that
advance a parent bookmark, publish externally, or integrate the parent
repository. Custom safety declarations are explicit trusted configuration;
they do not make arbitrary code safe.

The selected subgraph must have deterministic entry and terminal boundaries,
compatible symbolic exits, and no route that makes the parent traverse lane
sockets directly. Parallel regions cannot be nested or overlap. The normal
sequential loop may still use ordinary utilities and agent turns when their
capabilities are declared child-safe.

`maxConcurrency` is an explicit bounded scheduler setting, not a promise that
all lanes start together. Per-lane item retries and no-advance protection
retain the existing [workflow safety](workflow-safety.md) scopes. The parent
also enforces its aggregate token budget, child-process cancellation, and
bounded diagnostic/artifact output. Resolver retry budgets are separate from
child item retry budgets.

## 12. Minimal end-to-end example

A planner emits four canonical items and assigns them to two ordered streams:

```text
parallelSchedule:
  streams:
    api: [workItems[0], workItems[2]]
    ui:  [workItems[1], workItems[3]]
```

The normalizer creates stable lanes `api` and `ui`. With
`maxConcurrency: 2`, both child casts start from the same immutable baseline.
Each child runs Build → Eval → Maintain for its two items and checkpoints only
meaningful jj changes. If both lanes are accepted, the parent integrates
`api` then `ui` in that order. A clean integration goes to the evaluator; a
conflicted integration goes to the resolver and then the evaluator. If `ui`
fails, `api` is retained but no fan-in occurs, and revival reruns only `ui`.

See [Graph semantics](graph-semantics.md), [Loop semantics](loop-semantics.md),
[Utility materia](utility-materia.md), and [Workflow safety and resource
limits](workflow-safety.md) for the contracts that this experimental mode
composes.
