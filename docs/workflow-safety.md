# Workflow safety and resource limits

pi-materia's workflow safety model is **resource-scoped**: every enforced limit
is scoped to a single operator-controlled knob, a single invocation, a single
work item, or a single socket. Cumulative traversal counters are **diagnostic
only** and never fail execution, so legitimate long-running workflows with many
work items (20-30+ items per cast, each iterating a Build → Eval → Maintain
loop) cannot fail on a stale aggregate visit or edge count.

| Concern | Configured by | Scope | Behaviour |
| --- | --- | --- | --- |
| Token spend | `budget.maxTokens` (top-level) | Whole cast | Operator-controlled hard stop; **no automatic scaling** |
| Utility runtime | `timeoutMs` on utility materia | Per invocation | Bounded command execution; default 30000 ms |
| Retry budget | `edge.maxTraversals` | Per edge × work item | Explicit per-item retry budget; edges without it are unbounded |
| Stalled loops | `limits.maxNoAdvanceCycles` (top-level) | Per work item | Progress-aware structural fallback for unannotated cycles; default 3 |
| Output size | socket `limits.maxOutputBytes` | Per socket | Bounded socket output payload |
| Visit counts | `state.visits` | Diagnostic | Always recorded; **never enforced** |
| Aggregate traversals | `state.edgeTraversals` | Diagnostic | Always recorded; **never enforced** |

For the opt-in parallel loop contract, see [Parallel loop orchestration semantics](parallel-loop-orchestration.md). Parallel mode adds coordinator, child-process, and workspace rules without changing the resource scopes below for an ordinary sequential loop.

## Parallel loop safety (experimental)

Parallel mode is an explicitly bounded orchestration mode, not an implicit
relaxation of workflow limits:

- `maxConcurrency` bounds live child lanes. Queued streams do not create a
  process or workspace until a slot is available.
- The parent `budget.maxTokens` remains the aggregate hard stop. Child usage is
  counted once in parent totals; parallel execution never raises the budget or
  hides child cost.
- Per-item `edge.maxTraversals` and `limits.maxNoAdvanceCycles` retain their
  existing child-local scopes. A retry in one lane or item does not consume
  another lane's allowance. Resolver retries have their own explicit edge
  budgets.
- A child failure prevents fan-in but does not cancel healthy siblings. The
  coordinator waits for all lanes to become terminal unless the parent is
  cancelled or a hard global limit interrupts the run.
- Cancellation stops queued launches, terminates live child process trees,
  marks nonterminal lanes interrupted, and preserves workspaces and artifacts
  for diagnosis or revival. It is idempotent; late events cannot reopen a
  terminal lane.
- The parent workspace and bookmark remain unchanged through fan-out, child
  execution, and lane-local checkpoints. Shared repository state can advance
  only after all lanes succeed, fan-in/evaluation is accepted, and finalization
  verifies the result.

Parallel mode is jj-only and requires explicit child-safe capability metadata.
It rejects nested/overlapping regions and parent-shared operations such as
bookmark advancement or publishing from child subgraphs. See the full
[parallel orchestration contract](parallel-loop-orchestration.md) for durable
lane states, all-terminal failure, revival, artifact ownership, and conflict
resolution.

## Operator-controlled token budget

The top-level `budget` object configures the cast token budget:

```json
{
  "budget": {
    "maxTokens": 200000,
    "warnAtPercent": 75
  }
}
```

- `maxTokens` is a **hard stop**: the cast fails when `usage.tokens.total`
  reaches or exceeds it.
- `warnAtPercent` emits a warning when usage reaches the configured percentage
  of `maxTokens`. Cost values are telemetry only and never control warnings or
  enforcement.
- `/materia budget <tokens>` updates the active cast's limit **cast-locally**
  without rewriting source configuration and without automatically recasting.
  The requested value must be a non-negative safe whole number at least as
  large as the cast's consumed tokens.
- The runtime **never scales `maxTokens` automatically**. Long workflows are
  supported by unbounded ordinary traversal, not by silently raising the token
  budget; operators keep control through `/materia budget`.

## Per-invocation utility timeouts

Utility materia configure an optional per-invocation execution timeout:

```json
{
  "type": "utility",
  "command": ["node", "check.mjs"],
  "timeoutMs": 15000
}
```

`timeoutMs` bounds a **single invocation** of the utility command; the default
is 30000 ms. A timed-out invocation is terminated and the utility socket and
cast fail: the runtime does not route utility execution failures (including
timeouts) through same-socket recovery. A timeout does not consume or reset
any cumulative limit.

## Per-item explicit retry budgets

A retry budget is configured **on the edge itself**:

```json
{
  "edges": [
    { "when": "satisfied", "to": "Maintain" },
    { "when": "not_satisfied", "to": "Build", "maxTraversals": 3 }
  ]
}
```

Semantics:

- `edge.maxTraversals` is the **only** enforced traversal budget. It is an
  explicit retry allowance scoped by **edge and current work-item identity**
  (`from->to@<itemKey>`, with a singleton scope outside item loops).
- Retries consumed by one work item never reduce another item's allowance on
  the same edge. The runtime keeps retry counts in `state.scopedEdgeRetries`
  and revived-aware effective limits in `state.edgeAllowances`, both keyed by
  the scoped identity.
- Edges **without** `maxTraversals` are unbounded. There is no implicit
  cumulative cap: the historical hardcoded 25-traversal fallback is removed,
  and legacy global/socket `maxEdgeTraversals` settings are ignored.
- Exhaustion of an explicit retry budget fails the cast with structured
  `edge_traversal_exhausted` metadata. `/materia revive` extends **only that
  work item's** scoped allowance (by the original configured limit) and routes
  to the blocked target; other items' allowances are unaffected.

## Progress-aware no-advance protection

`limits.maxNoAdvanceCycles` (top-level, default 3) is the structural fallback
for **unannotated stalled loops**:

```json
{
  "limits": {
    "maxNoAdvanceCycles": 3
  }
}
```

- Tracking is scoped to the **current work item** and **resets immediately** on
  cursor or item advancement (`advance` and item selection clear the tracker).
- Re-entering a socket already on the current item's path closes one
  no-advance cycle. When the count exceeds the limit, the cast fails with
  `MateriaNoAdvanceCycleExhaustionError`, whose route diagnostics name the
  socket cycle involved.
- Re-entry via an explicit retry edge (`edge.maxTraversals`) is governed
  solely by that edge's per-item policy and does **not** advance the structural
  counter: no unrelated cumulative cap stacks on top of a configured retry
  budget.
- Genuinely unbounded same-item cycles (no explicit retry edge) still fail
  after the configured cycles, with useful route diagnostics.

## Socket output cap

`socket.limits.maxOutputBytes` remains a meaningful per-socket limit and is
the only socket-level limit surfaced in runtime summaries. It bounds the
socket's output payload.

## Diagnostic-only counters

These counters keep recording for artifact identity, provenance, telemetry,
and diagnostics, but are **never enforced**:

- `state.visits[socketId]` — cumulative socket visits (used in artifact
  paths such as `sockets/<socket-id>/<visit>.md`).
- `state.edgeTraversals["from->to"]` — aggregate from-to traversal counts.

Neither counter can fail execution, and legacy configurations that set very
low values for them still run normally.

## Obsolete cumulative limit fields

The following fields are **accepted for load compatibility but ignored**:

| Field | Location | Notes |
| --- | --- | --- |
| `maxSocketVisits` | top-level `limits` | Deprecated, ignored |
| `maxVisits` | socket `limits` | Deprecated, ignored |
| `maxEdgeTraversals` | top-level and socket `limits` | Deprecated, ignored |

They are marked deprecated in the type surface, have no shipped defaults, and
are omitted from runtime grid/limit summaries. Keeping them in a saved config
is safe: old low values are accepted without enforcement.

## Recovery

- Explicit retry exhaustion (`edge_traversal_exhausted`) is revivable: revive
  extends the exhausted work item's scoped allowance and routes to the blocked
  target without affecting other items. Legacy persisted exhaustion metadata
  whose allowance was stored under the aggregate key remains readable as a
  fallback.
- No-advance cycle exhaustion is an ordinary (non-exhaustion-metadata) cast
  failure for a genuinely stalled loop. Correct the loop structure first, then
  use `/materia recast`; do not revive a stalled cycle.
- Same-socket recovery exhaustion (JSON repair, tool timeout, context window)
  is revivable through the bounded same-socket allowance extension.

See [Resilient Inference and Revival](resilient-inference-and-revival.md) for
the full recovery design and [Loop semantics](loop-semantics.md) for how these
rules interact with cursor advancement and loop exits.
