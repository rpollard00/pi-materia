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

Place `Spawn-JJ-Workspace` in the derived branch prelude. Each stream creates one owned workspace and executes all its ordered items there. The base working copy remains unchanged during branch work. The utility exports ownership, integration, and cleanup data; parallel core transports those values without understanding jj.

## Runtime expectations

- Streams queue in normalized schedule order. At most the effective concurrency bound are live.
- Items remain sequential within a stream and keep their original work-item indexes.
- The parent token budget is aggregate; parallelism does not raise it.
- One failed branch does not immediately discard sibling diagnostics. The barrier waits for all terminal branches, then fails without partial fan-in.
- Successful barrier output is ordered by schedule, never completion time. Generic branch state is not merged.
- Empty plans complete without starting children or a normalization utility.

## Blackbelt checkpoints

`Blackbelt-Maintain` runs in the active scope cwd. For dirty work it describes the revision with the current item title, advances that scope's Blackbelt bookmark, and opens a fresh empty working commit. Clean work is a no-op. In parallel use, `Spawn-JJ-Workspace` provides a verified branch-local bookmark. Invocation in a shared base scope retaining the shared cast bookmark is rejected as unsafe.

## Integration, conflicts, and cleanup

After every branch is accepted, `Integrate-JJ-Workspaces` reads the ordered opaque exports, verifies workspace ownership and stable heads, and activates one integration workspace. A repository conflict is a bounded utility result, not an intrinsic fan-in route.

`Integration-Review` always runs. For a clean integration it spot-checks combined behavior; for a conflicted integration it resolves conflicts. In both cases it runs relevant checks and returns ordinary `satisfied` routing. A not-satisfied retry stays on this review socket and does not rerun accepted branches.

`Finalize-JJ-Workspace` runs only after acceptance. It snapshots review edits, verifies no conflicts remain, publishes the accepted revision through the intended bookmark, creates a verified empty base working commit, cleans only ownership-checked workspaces, and returns execution to base scope. Failure or rejection intentionally preserves workspaces, exports, and revisions. Never use broad `rm -rf`; cleanup must validate producer ownership and workspace manifests.

## Monitor and inspect

The TUI/WebUI derive fork, branch-prelude, loop, and barrier visuals from the generator/consumer relationship. Runtime status shows ordered branches, attempts, scopes, output, queued/running/terminal counts, cancellation, and barrier progress. It should not label generic fan-in as a VCS merge or conflict.

Inspect, in order:

1. cast state and `execution-scopes.json` for base, active, and branch scope identity/cwd;
2. cast-state parallel run/plan records for pinned identities and stream order;
3. `parallel/<loop-id>/lanes/<lane-id>/attempt-<n>/` for attempt-local coordinator identity, event, terminal, diagnostic, and usage files, then the child-session paths referenced by `lane.json` for launch, session, and child socket artifacts;
4. utility socket artifacts for spawn, integration, review, and finalization outcomes.

On revival, do not assume the attempt number determines every child path. A resumed child can retain an earlier `sessionPath`, `runDirectory`, and `artifactRoot`; only the coordinator evidence in the current `attempt-<n>` directory is guaranteed to be current-attempt-owned.

A replacement scope's terminal exports must appear at the barrier; seeing only the initial branch scope indicates a terminal-scope propagation problem.

## Cancel and revive

Cancellation stops queued launches, terminates running child processes, drains available telemetry, marks nonterminal branches interrupted, and retains artifacts/scopes. It is safe to repeat.

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
