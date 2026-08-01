# Loop semantics

This is the developer reference for generator-driven loop exits. The structured contract keeps current-item flow, cursor advancement, and post-loop routing separate.

## Runtime model

Runtime executes these socket-level fields:

1. `parse` decides whether socket output is parsed as JSON.
2. `assign` copies parsed values into state.
3. `advance` advances a cursor and detects exhaustion. It does not own post-loop routing.
4. Ordered `edges` choose the next socket for same-item or non-exhausted flow.

Loop-owned post-exhaustion routing is stored in `loops.<id>.exits`. If no route matches, completion falls through to terminal `end`.

## Control field

`satisfied` is the canonical boolean control field for `satisfied` / `not_satisfied` routing and for `advance.when`. Sockets that use those conditions must return JSON containing a boolean `satisfied`, and the socket must parse JSON.

## Build → Maintain loop

```json
{
  "entry": "Socket-1",
  "sockets": {
    "Socket-1": { "materia": "Auto-Plan", "parse": "json", "assign": { "workItems": "$.workItems" }, "edges": [{ "when": "always", "to": "Socket-3" }] },
    "Socket-3": { "materia": "Build", "edges": [{ "when": "always", "to": "Socket-4" }] },
    "Socket-4": {
      "materia": "Maintain",
      "parse": "json",
      "advance": { "cursor": "workItemIndex", "items": "state.workItems", "when": "satisfied" },
      "edges": [{ "when": "always", "to": "Socket-3" }]
    }
  },
  "loops": {
    "workItemIteration": {
      "sockets": ["Socket-3", "Socket-4"],
      "consumes": { "from": "Socket-1", "output": "workItems" },
      "exits": []
    }
  }
}
```

If Maintain returns `{ "satisfied": false }`, `advance.when` does not run and the `always` edge retries the current item. If Maintain returns `{ "satisfied": true }`, the cursor advances; non-final items continue to `Socket-3`, and final-item exhaustion resolves loop exits before falling back to `end`.

## Explicit post-loop route

```json
"loops": {
  "workItemIteration": {
    "sockets": ["Socket-4", "Socket-5", "Socket-6"],
    "consumes": { "from": "Socket-1", "output": "workItems" },
    "exits": [
      { "id": "exit:Socket-6:satisfied", "from": "Socket-6", "condition": "satisfied", "targetSocketId": "Socket-7" }
    ]
  }
}
```

A final satisfied item routes to `Socket-7`; otherwise the loop terminates at `end` unless another matching route is configured.

## Workflow safety in loops

Loop iteration is bounded by resource-scoped safety rules, not by cumulative visit or edge counters. See [Workflow safety and resource limits](workflow-safety.md) for the full model; the loop-relevant rules are:

- **Retries are per item.** An explicit `edge.maxTraversals` is a retry budget scoped by edge and the current work-item identity (`from->to@<itemKey>`). Retries consumed by one work item never reduce another item's allowance on the same edge, so a 30-item loop where every item legitimately revisits a socket succeeds independently of how many times other items traversed the same edge. Edges without an explicit `maxTraversals` are unbounded.
- **No-advance protection is progress-aware.** `limits.maxNoAdvanceCycles` (default 3) guards only unannotated stalled cycles for the **current** item and resets immediately when the cursor or item advances. Re-entry via an explicit retry edge uses that edge's per-item budget and does not advance the structural counter.
- **Counters are diagnostic.** `state.visits` and aggregate `state.edgeTraversals` continue to record for artifact identity and telemetry but never fail execution; legacy `maxSocketVisits`, `maxVisits`, and `maxEdgeTraversals` fields are accepted but ignored.
- **Token budget is operator-controlled.** The cast hard-stops at `budget.maxTokens`; the runtime never raises it automatically. Use `/materia budget <tokens>` to adjust a cast's limit.
