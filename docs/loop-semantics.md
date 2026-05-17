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
