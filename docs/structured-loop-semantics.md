# Structured loop semantics

Structured loop routing keeps item iteration separate from post-loop routing.

## Terms

- **Normal edge**: an ordered socket edge with `when: "always"`, `when: "satisfied"`, or `when: "not_satisfied"`. Normal edges route the current item between sockets.
- **Cursor advance**: the `advance` operation that increments a cursor after a socket completes and detects whether the consumed item list is exhausted.
- **Loop exhaustion**: the moment a loop has no current item left to process.
- **Loop exit route**: post-exhaustion routing metadata owned by `loops.<id>.exits`.
- **Terminal sentinel**: the string `"end"`.

## Decision order

For a socket completion, the graph chooses the next target in this order:

1. Parse output according to socket `parse` mode and apply `assign` updates.
2. Evaluate whether `advance` is eligible. `advance.when` reads only the parsed boolean `satisfied` field.
3. If eligible, increment the configured cursor once and detect whether the item list is exhausted.
4. If the list is not exhausted, select the first matching normal edge.
5. If the list is exhausted, resolve the owning loop route from `loops.<id>.exits`.
6. If a route matches, route to that target; otherwise terminate at `end`.

`advance` means cursor increment and exhaustion detection only. Post-loop routing belongs to `loops.<id>.exits`.

## Loop exit route precedence

A loop route is selected from `loops.<id>.exits` using the parsed canonical `satisfied` value from the socket that exhausted the loop:

- `satisfied === true`: prefer `satisfied`, then `always`.
- `satisfied === false`: prefer `not_satisfied`, then `always`.
- no boolean result: only `always` can match.

No matching route terminates at `end`.

## Empty-loop entry

When a loop is entered and the consumed item list has no item at the current cursor, the loop is exhausted before any member socket runs. The runtime resolves a matching `loops.<id>.exits` route when one is available, otherwise it terminates at `end`.

## Example

```json
{
  "loops": {
    "workItemIteration": {
      "sockets": ["Socket-4", "Socket-5", "Socket-6"],
      "consumes": { "from": "Socket-1", "output": "workItems" },
      "exits": [
        {
          "id": "exit:Socket-6:satisfied",
          "from": "Socket-6",
          "condition": "satisfied",
          "targetSocketId": "Socket-7"
        }
      ]
    }
  },
  "sockets": {
    "Socket-6": {
      "materia": "Maintain",
      "parse": "json",
      "advance": {
        "cursor": "workItemIndex",
        "items": "state.workItems",
        "when": "satisfied"
      },
      "edges": [{ "when": "always", "to": "Socket-4" }]
    }
  }
}
```

For non-final items, `advance` increments the cursor and the normal `always` edge continues to `Socket-4`. For the final item, loop exhaustion bypasses the normal back-edge and routes through `loops.workItemIteration.exits` to `Socket-7`.
