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

`Spawn-JJ-Workspace` replaces the branch active scope with an owned external workspace scope. It provisions branch-local Blackbelt bookmark state and opaque integration/cleanup exports while leaving the base working copy unchanged. The same utility can be placed after a regular generator and before a sequential loop to give the entire sequential path one workspace.

`Blackbelt-Maintain` uses the active scope cwd. It skips clean work, otherwise describes the current item, moves the scope-local bookmark, and opens a fresh empty commit. In a parallel child it accepts verified branch-local bookmark state and rejects an actual shared base bookmark; it does not rely on parallel core for checkpointing.

After intrinsic fan-in, `Integrate-JJ-Workspaces` consumes ordered scope exports, verifies ownership and stable heads, and materializes one clean or conflicted integration workspace. It supports one or many exported workspaces and activates the integrated scope. `Integration-Review` is reached for both outcomes: it resolves conflicts when present, otherwise spot-checks combined work, and runs relevant checks.

Only after agent acceptance does `Finalize-JJ-Workspace` snapshot review edits, verify the integration is conflict-free, describe and publish the accepted revision, create a verified empty base working commit, clean only owned workspaces, and return to base scope. Rejection or failure preserves scopes and revisions.

## 7. Persistence, cancellation, and revival

Durable parallel state pins plan, graph, branch, child-session, attempt, and execution-scope identities. Lane states are `queued`, `running`, `accepted`, `failed`, or `interrupted`. Terminal scopes and outputs are retained for ordered fan-in.

Cancellation is idempotent: it stops queued launches, aborts live children, drains available telemetry, marks nonterminal branches interrupted, and preserves state and artifacts. A fresh dispatcher can cancel persisted nonterminal runs.

`/materia revive <cast-id>` does not replan. It validates immutable plan and graph identity, complete child identity, retained initial data, scope and cwd, and artifact provenance. Accepted branches remain accepted; only failed or interrupted branches restart or resume. Attempts get distinct coordinator artifacts even when a child session retains older paths. Drift or missing scope data is an integrity failure, not a reason to guess.

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

Exact child artifact contents may grow, but identities, child-path provenance, and per-attempt coordinator provenance remain stable. Events expose stream order, branch status, attempt, scope id/cwd/export names, terminal output, usage, cancellation, and barrier progress. They do not present VCS conflicts as intrinsic fan-in state. Child token and cost usage is counted once in parent totals.

See [Graph semantics](graph-semantics.md), [Utility Materia](utility-materia.md), [Workflow safety](workflow-safety.md), and [Resilient Inference and Revival](resilient-inference-and-revival.md).
