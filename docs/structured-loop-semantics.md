# Structured loop semantics

Status: accepted design contract for structured loop routing. This document is normative for new runtime, validation, link compilation, materialization, and documentation work. Existing persisted loadouts remain supported through explicit compatibility or normalization paths; those paths and their removal conditions are inventoried in [Loop compatibility and sunset plan](loop-compatibility-sunset.md).

## Terms

- **Normal edge**: an ordered socket edge with `when: "always"`, `when: "satisfied"`, or `when: "not_satisfied"`. Normal edges route the current item between sockets; they are not loop-exhaustion metadata.
- **Cursor advance**: the `advance` operation that increments a cursor after a socket completes and detects whether the consumed item list is exhausted.
- **Loop exhaustion**: the moment a loop has no current item left to process, either before the first item runs or immediately after the final item completes.
- **Loop exit route**: canonical post-exhaustion routing metadata owned by `loops.<id>.exits`.
- **Terminal sentinel**: the string `"end"`. It is the only canonical graph/loadout terminal sentinel. It is not a socket id and has no aliases.

## Normative decision order

For a socket completion, the graph chooses the next target in this order:

1. Parse the output according to the socket parse mode and apply assignment/state updates.
2. Evaluate whether the socket's `advance` block is eligible to run. If `advance.when` is absent it is eligible; if it is `satisfied` or `not_satisfied`, it reads only the parsed boolean `satisfied` field.
3. If `advance` is eligible, increment the configured cursor exactly once and detect whether that increment exhausted the item list.
4. If the list is not exhausted, continue with normal ordered edge selection for the current graph position. The first matching normal edge wins; if no normal edge matches, the graph falls through to terminal `end`.
5. If the list is exhausted, resolve the owning loop's post-exhaustion route from `loops.<id>.exits`.
6. If a matching loop exit route exists, route to that socket target.
7. If no matching loop exit route exists, route to terminal `end`.

`advance` therefore means cursor increment and exhaustion detection only. It is not the canonical owner of post-loop routing in new-model loadouts.

## Loop exit route precedence

Loop exit metadata is the canonical post-exhaustion routing mechanism. A loop route is selected from `loops.<id>.exits` using the parsed canonical `satisfied` value from the socket that exhausted the loop:

- If `satisfied === true`, prefer a `satisfied` exit route from that socket, then an `always` route.
- If `satisfied === false`, prefer a `not_satisfied` exit route from that socket, then an `always` route.
- If no boolean satisfaction result is available, only an `always` route can match.

Loop exit routes target sockets. Terminal completion is represented by the absence of a matching loop exit route, which falls back to `end`.

`satisfied` and `not_satisfied` are normal control-flow predicates. They are also route conditions for loop exit metadata, but they remain derived from the same canonical boolean `satisfied` field. They must not be replaced with legacy aliases such as `passed`, and they must not be repurposed as arbitrary loop-status fields.

## Empty-loop entry

When a loop is entered and the consumed item list has no item at the current cursor, the loop is exhausted before any member socket runs. New-model behavior uses the same post-exhaustion rule as final-item completion:

1. Resolve the loop's matching `loops.<id>.exits` route for the entry/exhaustion point when one is available.
2. If no matching route exists, terminate at `end`.

Compatibility layers may continue to read legacy iterator `done` fields while normalizing old loadouts, but new authoring should express post-loop routing through loop exit metadata rather than per-socket or iterator `done` targets.

## Post-final-item exhaustion

When a loop member completes the final item and its eligible `advance` increments the cursor past the end of the consumed list, the runtime must not treat `advance.done` as the canonical destination. The canonical destination is:

1. the selected `loops.<id>.exits` route target, or
2. terminal `end` when the loop has no matching exit route.

Normal same-item edges such as `not_satisfied` retry edges and `satisfied` forward edges remain normal edges. They run only when no exhaustion target has been returned.

## Examples

### Explicit loop exit routing

This loop advances on `Socket-6` when Maintain returns `{ "satisfied": true }`. After the final item, the loop-owned exit route sends execution to `Socket-7`.

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

### No-exit fallback to terminal `end`

This loop has no `exits` route. After the final item, completion falls through to the loadout terminal sentinel.

```json
{
  "loops": {
    "workItemIteration": {
      "sockets": ["Socket-4", "Socket-5", "Socket-6"],
      "consumes": { "from": "Socket-1", "output": "workItems" },
      "exits": []
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

The fallback target is `end` because no loop-owned post-exhaustion route exists. New-model loadouts do not need to encode `done: "end"` in `advance` to express this terminal fallback.

## Legacy compatibility

Older and UI-authored loadouts may contain `advance.done`, `foreach.done`, `loop.iterator.done`, or legacy `loops.<id>.exit.to` values. These fields are compatibility inputs for migration or normalization, not future authoring guidance.

Compatibility rules:

- Existing `advance.done: "end"` must be accepted where current persisted loadouts rely on it, because `end` is the canonical terminal sentinel.
- Existing `advance.done: "Socket-N"` may be normalized into an equivalent loop exit route when it clearly represents post-exhaustion routing.
- Canonical `loops.<id>.exits` routes take precedence over legacy `advance.done` routing when both are present.
- Unknown non-sentinel targets remain invalid and must not be treated as terminal fallback.
- Compatibility shims must be named, documented, test-covered, and sunsettable.

New loadouts should omit `advance.done` for post-loop routing and use `loops.<id>.exits` plus the default no-route fallback to `end`. A loadout is considered new-model or normalized when socket-valued legacy `loop.exit.to` and loop-member `advance.done` routes have equivalent `loops.<id>.exits` entries, normal loop back-edges remain ordinary same-item edges, and UI descriptive edges/runes are not treated as routing unless backed by canonical exit metadata.
